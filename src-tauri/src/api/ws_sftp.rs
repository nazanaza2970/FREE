//! `/ws/sftp` — parity with `server/sftp.ts`. One WebSocket carries one SFTP
//! session; frames are JSON per `shared/sftp.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::db;
use crate::ssh;
use crate::state::AppState;

const DATA_CHUNK: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Open { host_id: i64 },
    List { path: String },
    Stat { path: String },
    Mkdir { path: String },
    #[serde(rename_all = "camelCase")]
    Rename { from: String, to: String },
    #[serde(rename_all = "camelCase")]
    Remove {
        path: String,
        // Parsed for wire parity; TS always removed recursively.
        #[allow(dead_code)]
        recursive: bool,
    },
    Chmod { path: String, mode: u32 },
    #[serde(rename_all = "camelCase")]
    Chown { path: String, uid: u32, gid: u32 },
    Symlink { target: String, path: String },
    #[serde(rename_all = "camelCase")]
    DownloadStart { id: String, path: String },
    #[serde(rename_all = "camelCase")]
    UploadStart { id: String, path: String, size: u64 },
    #[serde(rename_all = "camelCase")]
    UploadChunk { id: String, data: String },
    #[serde(rename_all = "camelCase")]
    UploadEnd { id: String },
    Cancel { id: String },
}

#[derive(Debug, Serialize)]
struct SftpEntryOut {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    mtime: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServerMsg {
    Opened {
        cwd: String,
    },
    Entries {
        path: String,
        entries: Vec<SftpEntryOut>,
    },
    Entry {
        entry: SftpEntryOut,
    },
    Ok {
        op: &'static str,
    },
    Data {
        id: String,
        data: String,
    },
    Progress {
        id: String,
        transferred: u64,
        total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        id: String,
        op: &'static str,
        bytes: u64,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

fn entry_out(name: String, dir: &str, attrs: &FileAttributes) -> SftpEntryOut {
    let path = if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    };
    let entry_type = if attrs.is_dir() {
        "directory"
    } else if attrs.is_symlink() {
        "symlink"
    } else if attrs.is_regular() {
        "file"
    } else {
        "other"
    };
    SftpEntryOut {
        name,
        path,
        entry_type,
        size: attrs.size.unwrap_or(0),
        mode: attrs.permissions.unwrap_or(0),
        uid: attrs.uid.unwrap_or(0),
        gid: attrs.gid.unwrap_or(0),
        mtime: attrs.mtime.unwrap_or(0) as u64,
    }
}

/// TS `entryFromAttrs(path.split('/').pop(), path.slice(0, path.lastIndexOf('/')) || '/', attrs)`.
fn stat_entry(path: &str, attrs: &FileAttributes) -> SftpEntryOut {
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    let dir = match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => path[..i].to_string(),
    };
    entry_out(name, &dir, attrs)
}

fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn attrs_with(f: impl FnOnce(&mut FileAttributes)) -> FileAttributes {
    let mut attrs = FileAttributes {
        size: None,
        uid: None,
        user: None,
        gid: None,
        group: None,
        permissions: None,
        atime: None,
        mtime: None,
    };
    f(&mut attrs);
    attrs
}

pub async fn ws_upgrade(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

struct Connection {
    sftp: Option<Arc<SftpSession>>,
    /// Keeps the SSH connection alive; dropping it closes the channel.
    handle: Option<ssh::SshHandle>,
    opening: bool,
    host_id: i64,
}

struct DownloadState {
    cancelled: Arc<AtomicBool>,
}

struct UploadState {
    file: File,
    transferred: u64,
    total: u64,
    path: String,
    name: String,
}

/// Reader loop exit reasons: a failed `open` kills the socket (TS onDead).
async fn handle_socket(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMsg>(2048);
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let text = serde_json::to_string(&msg).unwrap_or_default();
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let conn = Arc::new(Mutex::new(Connection {
        sftp: None,
        handle: None,
        opening: false,
        host_id: 0,
    }));
    let downloads: Arc<Mutex<HashMap<String, DownloadState>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut uploads: HashMap<String, UploadState> = HashMap::new();

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(cm) = serde_json::from_str::<ClientMsg>(&text) else {
            continue;
        };
        if handle_msg(&state, &conn, &downloads, &mut uploads, &out_tx, cm).await {
            break; // open failed: close the socket (TS onDead).
        }
    }

    for d in downloads.lock().expect("downloads mutex").values() {
        d.cancelled.store(true, Ordering::SeqCst);
    }
    let handle = {
        let mut c = conn.lock().expect("conn mutex");
        c.sftp = None;
        c.handle.take()
    };
    if let Some(handle) = handle {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
    }
    writer.abort();
}

fn current_sftp(conn: &Arc<Mutex<Connection>>) -> Option<Arc<SftpSession>> {
    conn.lock().expect("conn mutex").sftp.clone()
}

fn host_id_of(conn: &Arc<Mutex<Connection>>) -> i64 {
    conn.lock().expect("conn mutex").host_id
}

async fn send_err(out_tx: &mpsc::Sender<ServerMsg>, message: &str, id: Option<&str>) {
    let _ = out_tx
        .send(ServerMsg::Error {
            message: message.to_string(),
            id: id.map(|s| s.to_string()),
        })
        .await;
}

async fn remove_recursive(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let attrs = sftp.metadata(path).await.map_err(err_str)?;
    if attrs.is_dir() {
        let rd = sftp.read_dir(path).await.map_err(err_str)?;
        for entry in rd {
            let name = entry.file_name();
            let child = if path == "/" {
                format!("/{name}")
            } else {
                format!("{path}/{name}")
            };
            Box::pin(remove_recursive(sftp, &child)).await?;
        }
        sftp.remove_dir(path).await.map_err(err_str)
    } else {
        sftp.remove_file(path).await.map_err(err_str)
    }
}

/// Handles one client frame. Returns true when the socket must be closed.
async fn handle_msg(
    state: &AppState,
    conn: &Arc<Mutex<Connection>>,
    downloads: &Arc<Mutex<HashMap<String, DownloadState>>>,
    uploads: &mut HashMap<String, UploadState>,
    out_tx: &mpsc::Sender<ServerMsg>,
    msg: ClientMsg,
) -> bool {
    match msg {
        ClientMsg::Open { host_id } => {
            let already = {
                let c = conn.lock().expect("conn mutex");
                c.sftp.is_some() || c.opening
            };
            if already {
                return false;
            }
            {
                let mut c = conn.lock().expect("conn mutex");
                c.opening = true;
            }
            let result = open_connection(state, host_id, out_tx).await;
            let mut c = conn.lock().expect("conn mutex");
            c.opening = false;
            match result {
                Ok((sftp, handle)) => {
                    c.sftp = Some(sftp);
                    c.handle = Some(handle);
                    c.host_id = host_id;
                    false
                }
                Err(()) => true,
            }
        }
        ClientMsg::List { path } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                match sftp.read_dir(&path).await {
                    Ok(rd) => {
                        let mut entries: Vec<SftpEntryOut> = Vec::new();
                        for entry in rd {
                            let name = entry.file_name();
                            let attrs = entry.metadata();
                            entries.push(entry_out(name, &path, &attrs));
                        }
                        // TS: directories first, then name localeCompare.
                        entries.sort_by(|a, b| {
                            let a_dir = a.entry_type == "directory";
                            let b_dir = b.entry_type == "directory";
                            b_dir.cmp(&a_dir).then_with(|| a.name.cmp(&b.name))
                        });
                        let _ = out.send(ServerMsg::Entries { path, entries }).await;
                    }
                    Err(e) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(conn, "sftp.error", Some(host_id), &format!("list: {e}"))
                                .ok()
                        });
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("list: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Stat { path } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            tokio::spawn(async move {
                match sftp.metadata(&path).await {
                    Ok(attrs) => {
                        let _ = out
                            .send(ServerMsg::Entry {
                                entry: stat_entry(&path, &attrs),
                            })
                            .await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("stat: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Mkdir { path } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                match sftp.create_dir(&path).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(conn, "sftp.mkdir", Some(host_id), &path).ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "mkdir" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("mkdir: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Rename { from, to } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                match sftp.rename(&from, &to).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(
                                conn,
                                "sftp.rename",
                                Some(host_id),
                                &format!("{from} -> {to}"),
                            )
                            .ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "rename" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("rename: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        // TS always calls removeRecursive (ignores the flag).
        ClientMsg::Remove { path, recursive: _ } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                match remove_recursive(&sftp, &path).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(conn, "sftp.remove", Some(host_id), &path).ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "remove" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("remove: {e}"),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Chmod { path, mode } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                let attrs = attrs_with(|a| a.permissions = Some(mode));
                match sftp.set_metadata(&path, attrs).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(
                                conn,
                                "sftp.chmod",
                                Some(host_id),
                                &format!("{path} {:o}", mode),
                            )
                            .ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "chmod" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("chmod: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Chown { path, uid, gid } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                let attrs = attrs_with(|a| {
                    a.uid = Some(uid);
                    a.gid = Some(gid);
                });
                match sftp.set_metadata(&path, attrs).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(
                                conn,
                                "sftp.chown",
                                Some(host_id),
                                &format!("{path} {uid}:{gid}"),
                            )
                            .ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "chown" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("chown: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::Symlink { target, path } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", None).await;
                return false;
            };
            let out = out_tx.clone();
            let state = state.clone();
            let host_id = host_id_of(conn);
            tokio::spawn(async move {
                // TS: symlink(target, path) → link at `path` pointing to `target`.
                match sftp.symlink(&path, &target).await {
                    Ok(()) => {
                        let _ = state.with_db(|conn| {
                            db::add_audit(
                                conn,
                                "sftp.symlink",
                                Some(host_id),
                                &format!("{path} -> {target}"),
                            )
                            .ok()
                        });
                        let _ = out.send(ServerMsg::Ok { op: "symlink" }).await;
                    }
                    Err(e) => {
                        let _ = out
                            .send(ServerMsg::Error {
                                message: format!("symlink: {}", err_str(e)),
                                id: None,
                            })
                            .await;
                    }
                }
            });
            false
        }
        ClientMsg::DownloadStart { id, path } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", Some(&id)).await;
                return false;
            };
            match sftp.metadata(&path).await {
                Ok(attrs) if attrs.is_regular() => {
                    let cancelled = Arc::new(AtomicBool::new(false));
                    downloads
                        .lock()
                        .expect("downloads mutex")
                        .insert(id.clone(), DownloadState { cancelled: Arc::clone(&cancelled) });
                    let out = out_tx.clone();
                    let state = state.clone();
                    let host_id = host_id_of(conn);
                    let total = attrs.size.unwrap_or(0);
                    let _ = out
                        .send(ServerMsg::Progress {
                            id: id.clone(),
                            transferred: 0,
                            total,
                        })
                        .await;
                    tokio::spawn(async move {
                        run_download(sftp, state, host_id, id, path, total, cancelled, out).await;
                    });
                }
                _ => {
                    send_err(out_tx, &format!("download: not a file: {path}"), Some(&id)).await;
                }
            }
            false
        }
        ClientMsg::UploadStart { id, path, size } => {
            let Some(sftp) = current_sftp(conn) else {
                send_err(out_tx, "not connected", Some(&id)).await;
                return false;
            };
            if uploads.contains_key(&id) {
                return false;
            }
            let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
            match sftp.open_with_flags(&path, flags).await {
                Ok(file) => {
                    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
                    uploads.insert(
                        id.clone(),
                        UploadState { file, transferred: 0, total: size, path, name },
                    );
                    let _ = out_tx
                        .send(ServerMsg::Progress { id, transferred: 0, total: size })
                        .await;
                }
                Err(e) => {
                    send_err(out_tx, &format!("upload: {}", err_str(e)), Some(&id)).await;
                }
            }
            false
        }
        ClientMsg::UploadChunk { id, data } => {
            let Some(upload) = uploads.get_mut(&id) else {
                return false;
            };
            let Ok(buf) = B64.decode(&data) else {
                return false;
            };
            match upload.file.write_all(&buf).await {
                Ok(()) => {
                    upload.transferred += buf.len() as u64;
                    let _ = out_tx
                        .send(ServerMsg::Progress {
                            id,
                            transferred: upload.transferred,
                            total: upload.total,
                        })
                        .await;
                }
                Err(e) => {
                    uploads.remove(&id);
                    send_err(out_tx, &format!("upload: {}", err_str(e)), Some(&id)).await;
                }
            }
            false
        }
        ClientMsg::UploadEnd { id } => {
            let Some(mut upload) = uploads.remove(&id) else {
                return false;
            };
            let _ = upload.file.flush().await;
            drop(upload.file);
            let bytes = upload.transferred;
            let state = state.clone();
            let host_id = host_id_of(conn);
            let detail = format!("{} ({bytes} bytes)", upload.path);
            let _ = state.with_db(|conn| {
                db::add_audit(conn, "sftp.upload", Some(host_id), &detail).ok()
            });
            let _ = out_tx.send(ServerMsg::Done { id, op: "upload", bytes }).await;
            false
        }
        ClientMsg::Cancel { id } => {
            let download = downloads.lock().expect("downloads mutex").remove(&id);
            if let Some(d) = download {
                d.cancelled.store(true, Ordering::SeqCst);
                return false;
            }
            if let Some(mut upload) = uploads.remove(&id) {
                // TS upload cancel: end() flushes buffered bytes so a partial
                // file reliably lands on disk.
                let _ = upload.file.flush().await;
                drop(upload.file);
                let bytes = upload.transferred;
                let detail = format!("upload {} @ {}/{}", upload.name, bytes, upload.total);
                let state = state.clone();
                let host_id = host_id_of(conn);
                let _ = state.with_db(|conn| {
                    db::add_audit(conn, "sftp.cancel", Some(host_id), &detail).ok()
                });
                let _ = out_tx.send(ServerMsg::Done { id, op: "upload", bytes }).await;
            }
            false
        }
    }
}

async fn run_download(
    sftp: Arc<SftpSession>,
    state: AppState,
    host_id: i64,
    id: String,
    path: String,
    total: u64,
    cancelled: Arc<AtomicBool>,
    out: mpsc::Sender<ServerMsg>,
) {
    let mut file = match sftp.open(&path).await {
        Ok(file) => file,
        Err(e) => {
            let _ = out
                .send(ServerMsg::Error {
                    message: format!("download: {}", err_str(e)),
                    id: Some(id),
                })
                .await;
            return;
        }
    };
    let mut buf = vec![0u8; DATA_CHUNK];
    let mut transferred: u64 = 0;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        let n = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = out
                    .send(ServerMsg::Error {
                        message: format!("download: {}", err_str(e)),
                        id: Some(id),
                    })
                    .await;
                return;
            }
        };
        transferred += n as u64;
        if out
            .send(ServerMsg::Data {
                id: id.clone(),
                data: B64.encode(&buf[..n]),
            })
            .await
            .is_err()
        {
            return;
        }
    }
    let was_cancelled = cancelled.load(Ordering::SeqCst);
    let _ = state.with_db(|conn| {
        if was_cancelled {
            db::add_audit(
                conn,
                "sftp.cancel",
                Some(host_id),
                &format!("download {path} @ {transferred}/{total}"),
            )
            .ok()
        } else {
            db::add_audit(
                conn,
                "sftp.download",
                Some(host_id),
                &format!("{path} ({transferred} bytes)"),
            )
            .ok()
        }
    });
    let _ = out
        .send(ServerMsg::Done { id, op: "download", bytes: transferred })
        .await;
}

async fn connect_fail(
    state: &AppState,
    host_id: i64,
    out_tx: &mpsc::Sender<ServerMsg>,
    message: String,
    audit: bool,
) -> Result<(Arc<SftpSession>, ssh::SshHandle), ()> {
    let _ = out_tx
        .send(ServerMsg::Error { message: message.clone(), id: None })
        .await;
    if audit {
        state.add_audit("sftp.error", Some(host_id), &message);
    }
    Err(())
}

/// Connect + SFTP subsystem + TOFU, sending `opened` on success (parity with
/// `openConnection` in server/sftp.ts).
async fn open_connection(
    state: &AppState,
    host_id: i64,
    out_tx: &mpsc::Sender<ServerMsg>,
) -> Result<(Arc<SftpSession>, ssh::SshHandle), ()> {
    let host = match state.with_db(|conn| db::get_host(conn, host_id)) {
        Ok(Some(host)) => host,
        Ok(None) => return connect_fail(state, host_id, out_tx, "host not found".into(), false).await,
        Err(e) => return connect_fail(state, host_id, out_tx, e.to_string(), false).await,
    };

    let auth = match ssh::build_auth(&host) {
        Ok(auth) => auth,
        Err(message) => return connect_fail(state, host_id, out_tx, message, true).await,
    };

    let (handler, host_key) = ssh::TermHandler::new();
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        ..<_>::default()
    });
    let addrs = (host.host.as_str(), host.port as u16);
    let connected = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, addrs, handler),
    )
    .await;
    let mut handle = match connected {
        Err(_) => {
            return connect_fail(state, host_id, out_tx, "connection timed out".into(), true).await
        }
        Ok(Err(e)) => return connect_fail(state, host_id, out_tx, e.to_string(), true).await,
        Ok(Ok(handle)) => handle,
    };

    if let Err(message) = ssh::authenticate(&mut handle, &host.username, auth).await {
        let result = connect_fail(state, host_id, out_tx, message, true).await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return result;
    }

    // Host-key TOFU / mismatch (parity with sftp.ts: unknown → trust,
    // mismatch → error + die; there is no hostkey frame on the SFTP socket).
    let blob = host_key.lock().expect("host key mutex").clone();
    if let Some(blob) = blob {
        let fingerprint = ssh::host_key_fingerprint(&blob);
        let known = state
            .with_db(|conn| db::get_known_host(conn, &host.host, host.port).ok().flatten());
        if known
            .as_ref()
            .map(|k| k.fingerprint != fingerprint)
            .unwrap_or(false)
        {
            let known_fp = known.as_ref().expect("known host").fingerprint.clone();
            let message = format!("host key mismatch: expected {known_fp} got {fingerprint}");
            state.add_audit(
                "hostkey.mismatch",
                Some(host.id),
                &format!(
                    "{}:{} expected {} got {}",
                    host.host, host.port, known_fp, fingerprint
                ),
            );
            let result = connect_fail(state, host_id, out_tx, message, false).await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return result;
        }
        if known.is_none() {
            let alg = ssh::host_key_alg(&blob);
            let _ = state.with_db(|conn| {
                db::upsert_known_host(conn, &host.host, host.port, &alg, &fingerprint)
            });
            state.add_audit(
                "hostkey.trusted",
                Some(host.id),
                &format!("{}:{} {}", host.host, host.port, fingerprint),
            );
        }
    }

    let channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(e) => {
            let result = connect_fail(state, host_id, out_tx, format!("sftp: {e}"), true).await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return result;
        }
    };
    if let Err(e) = channel.request_subsystem(true, "sftp").await {
        let result = connect_fail(state, host_id, out_tx, format!("sftp: {e}"), true).await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return result;
    }
    let sftp = match tokio::time::timeout(
        Duration::from_secs(15),
        SftpSession::new(channel.into_stream()),
    )
    .await
    {
        Err(_) => {
            let result =
                connect_fail(state, host_id, out_tx, "sftp: initialization timed out".into(), true)
                    .await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return result;
        }
        Ok(Err(e)) => {
            let result = connect_fail(state, host_id, out_tx, format!("sftp: {e}"), true).await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return result;
        }
        Ok(Ok(sftp)) => Arc::new(sftp),
    };

    let cwd = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    state.add_audit(
        "sftp.connect",
        Some(host.id),
        &format!("{} ({}:{}) cwd={}", host.name, host.host, host.port, cwd),
    );
    let _ = out_tx.send(ServerMsg::Opened { cwd }).await;

    Ok((sftp, handle))
}
