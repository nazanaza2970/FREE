//! `/ws/terminal` — parity with `server/terminal.ts`. One WebSocket carries
//! one session; frames are JSON per `shared/protocol.ts`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

use crate::db;
use crate::models::Host;
use crate::ssh;
use crate::state::{AppState, SessionEntry};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Connect {
        session_id: String,
        host_id: i64,
        #[serde(default)]
        trust: bool,
    },
    #[serde(rename_all = "camelCase")]
    Input {
        session_id: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        session_id: String,
        cols: u32,
        rows: u32,
    },
    #[serde(rename_all = "camelCase")]
    Disconnect {
        session_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerMsg {
    #[serde(rename_all = "camelCase")]
    Output {
        session_id: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        session_id: String,
        state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Hostkey {
        session_id: String,
        state: &'static str,
        fingerprint: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Exit {
        session_id: String,
        code: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        session_id: String,
        message: String,
    },
}

#[derive(Debug, Clone)]
enum SessionCmd {
    Input(String),
    Resize { cols: u32, rows: u32 },
}

struct ActiveSession {
    id: String,
    host_id: i64,
    cmd_tx: mpsc::Sender<SessionCmd>,
    shutdown: Arc<Notify>,
}

fn max_sessions() -> usize {
    std::env::var("MAX_SESSIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(32)
}

fn reconnect_cooldown_ms() -> u64 {
    std::env::var("RECONNECT_COOLDOWN_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000)
}

pub async fn ws_upgrade(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

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

    let mut active: Option<ActiveSession> = None;
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(cm) = serde_json::from_str::<ClientMsg>(&text) else {
            continue;
        };
        match cm {
            ClientMsg::Connect {
                session_id,
                host_id,
                trust,
            } => {
                // Parity: one live session per socket; a session that has
                // exited frees the slot (TS cleared activeSessionId onDead).
                if let Some(a) = &active {
                    if !a.cmd_tx.is_closed() {
                        let _ = out_tx
                            .send(ServerMsg::Error {
                                session_id,
                                message: "session already active on this socket".into(),
                            })
                            .await;
                        continue;
                    }
                }
                let count = state.sessions.lock().expect("sessions mutex").len();
                if count >= max_sessions() {
                    let _ = out_tx
                        .send(ServerMsg::Error {
                            session_id,
                            message: format!(
                                "too many concurrent sessions (max {})",
                                max_sessions()
                            ),
                        })
                        .await;
                    continue;
                }
                let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCmd>(256);
                let shutdown = Arc::new(Notify::new());
                state.sessions.lock().expect("sessions mutex").insert(
                    session_id.clone(),
                    SessionEntry {
                        host_id,
                        shutdown: Arc::clone(&shutdown),
                    },
                );
                tokio::spawn(session_task(
                    state.clone(),
                    session_id.clone(),
                    host_id,
                    trust,
                    cmd_rx,
                    Arc::clone(&shutdown),
                    out_tx.clone(),
                ));
                active = Some(ActiveSession {
                    id: session_id,
                    host_id,
                    cmd_tx,
                    shutdown,
                });
            }
            ClientMsg::Input { session_id, data } => {
                if let Some(a) = &active {
                    if a.id == session_id {
                        let _ = a.cmd_tx.send(SessionCmd::Input(data)).await;
                    }
                }
            }
            ClientMsg::Resize {
                session_id,
                cols,
                rows,
            } => {
                if let Some(a) = &active {
                    if a.id == session_id {
                        let _ = a.cmd_tx.send(SessionCmd::Resize { cols, rows }).await;
                    }
                }
            }
            ClientMsg::Disconnect { session_id } => {
                if let Some(a) = active.take() {
                    if a.id == session_id {
                        state
                            .sessions
                            .lock()
                            .expect("sessions mutex")
                            .remove(&a.id);
                        a.shutdown.notify_waiters();
                    } else {
                        active = Some(a);
                    }
                }
            }
        }
    }

    if let Some(a) = active.take() {
        if !a.cmd_tx.is_closed() {
            state.add_audit("session.closed", Some(a.host_id), "socket closed");
        }
        state
            .sessions
            .lock()
            .expect("sessions mutex")
            .remove(&a.id);
        a.shutdown.notify_waiters();
    }
    writer.abort();
}

/// Removes the session from the registry when the task ends (idempotent).
struct SessionGuard {
    state: AppState,
    session_id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.state
            .sessions
            .lock()
            .expect("sessions mutex")
            .remove(&self.session_id);
    }
}

async fn session_task(
    state: AppState,
    session_id: String,
    host_id: i64,
    trust: bool,
    cmd_rx: mpsc::Receiver<SessionCmd>,
    shutdown: Arc<Notify>,
    out_tx: mpsc::Sender<ServerMsg>,
) {
    let _guard = SessionGuard {
        state: state.clone(),
        session_id: session_id.clone(),
    };

    let send = {
        let out_tx = out_tx.clone();
        move |msg: ServerMsg| {
            let out_tx = out_tx.clone();
            async move {
                let _ = out_tx.send(msg).await;
            }
        }
    };

    let _ = send(ServerMsg::Status {
        session_id: session_id.clone(),
        state: "connecting",
        detail: None,
    })
    .await;

    let host = match state.with_db(|conn| db::get_host(conn, host_id)) {
        Ok(Some(host)) => host,
        Ok(None) => {
            let _ = send(ServerMsg::Error {
                session_id,
                message: "host not found".into(),
            })
            .await;
            return;
        }
        Err(e) => {
            let _ = send(ServerMsg::Error {
                session_id,
                message: e.to_string(),
            })
            .await;
            return;
        }
    };

    // Per-host reconnect cooldown (parity with recentCloses in the TS server).
    let cooldown = reconnect_cooldown_ms();
    if cooldown > 0 {
        let last_close = state
            .recent_closes
            .lock()
            .expect("recent_closes mutex")
            .get(&host_id)
            .copied();
        let active_on_host = state
            .sessions
            .lock()
            .expect("sessions mutex")
            .values()
            .any(|s| s.host_id == host_id);
        if let Some(last) = last_close {
            if !active_on_host && last.elapsed() < Duration::from_millis(cooldown) {
                let wait =
                    (cooldown.saturating_sub(last.elapsed().as_millis() as u64)).div_ceil(1000);
                let _ = send(ServerMsg::Status {
                    session_id,
                    state: "error",
                    detail: Some(format!("reconnect cooldown: retry in {wait}s")),
                })
                .await;
                return;
            }
        }
    }

    match host.connection_type.as_str() {
        "telnet" => run_telnet(state, session_id, host, cmd_rx, shutdown, out_tx).await,
        "mosh" => run_mosh(state, session_id, host, cmd_rx, shutdown, out_tx).await,
        _ => run_ssh(state, session_id, host, trust, cmd_rx, shutdown, out_tx).await,
    }
}

fn record_close(state: &AppState, host_id: i64) {
    let mut rc = state.recent_closes.lock().expect("recent_closes mutex");
    rc.insert(host_id, Instant::now());
    if rc.len() > 128 {
        let cutoff = Instant::now() - Duration::from_secs(60);
        rc.retain(|_, at| *at > cutoff);
    }
}

async fn run_ssh(
    state: AppState,
    session_id: String,
    host: Host,
    trust: bool,
    mut cmd_rx: mpsc::Receiver<SessionCmd>,
    shutdown: Arc<Notify>,
    out_tx: mpsc::Sender<ServerMsg>,
) {
    let send = {
        let out_tx = out_tx.clone();
        move |msg: ServerMsg| {
            let out_tx = out_tx.clone();
            async move {
                let _ = out_tx.send(msg).await;
            }
        }
    };

    let auth = match ssh::build_auth(&host) {
        Ok(auth) => auth,
        Err(message) => {
            let _ = send(ServerMsg::Error {
                session_id: session_id.clone(),
                message: message.clone(),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
    };

    let (handler, host_key) = ssh::TermHandler::with_agent(host.agent_forward.then(|| state.clone()));
    let keepalive = host.keepalive.max(5) as u64;
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(keepalive)),
        keepalive_max: 0,
        ..<_>::default()
    });

    let addrs = (host.host.as_str(), host.port as u16);
    let connected = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, addrs, handler),
    )
    .await;
    let handle = match connected {
        Err(_) => {
            let message = "connection timed out".to_string();
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some(message.clone()),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
        Ok(Err(e)) => {
            let message = e.to_string();
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some(message.clone()),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
        Ok(Ok(handle)) => handle,
    };
    let mut handle = handle;

    if let Err(message) = ssh::authenticate(&mut handle, &host.username, auth).await {
        let _ = send(ServerMsg::Status {
            session_id,
            state: "error",
            detail: Some(message.clone()),
        })
        .await;
        state.add_audit("session.error", Some(host.id), &message);
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return;
    }

    // Host-key TOFU / mismatch handling (parity with terminal.ts openSsh).
    let blob = host_key.lock().expect("host key mutex").clone();
    if let Some(blob) = blob {
        let fingerprint = ssh::host_key_fingerprint(&blob);
        let known = state
            .with_db(|conn| db::get_known_host(conn, &host.host, host.port).ok().flatten());
        if trust {
            let alg = ssh::host_key_alg(&blob);
            let _ = state.with_db(|conn| {
                db::upsert_known_host(conn, &host.host, host.port, &alg, &fingerprint)
            });
            state.add_audit(
                "hostkey.trusted",
                Some(host.id),
                &format!("{}:{} {}", host.host, host.port, fingerprint),
            );
            let _ = send(ServerMsg::Hostkey {
                session_id: session_id.clone(),
                state: "new",
                fingerprint,
                expected: None,
            })
            .await;
        } else if known
            .as_ref()
            .map(|k| k.fingerprint != fingerprint)
            .unwrap_or(false)
        {
            let known = known.as_ref().expect("known host");
            let _ = send(ServerMsg::Hostkey {
                session_id: session_id.clone(),
                state: "mismatch",
                fingerprint: fingerprint.clone(),
                expected: Some(known.fingerprint.clone()),
            })
            .await;
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some("host key mismatch".into()),
            })
            .await;
            state.add_audit(
                "hostkey.mismatch",
                Some(host.id),
                &format!(
                    "{}:{} expected {} got {}",
                    host.host, host.port, known.fingerprint, fingerprint
                ),
            );
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return;
        } else if known.is_none() {
            let alg = ssh::host_key_alg(&blob);
            let _ = state.with_db(|conn| {
                db::upsert_known_host(conn, &host.host, host.port, &alg, &fingerprint)
            });
            state.add_audit(
                "hostkey.trusted",
                Some(host.id),
                &format!("{}:{} {}", host.host, host.port, fingerprint),
            );
            let _ = send(ServerMsg::Hostkey {
                session_id: session_id.clone(),
                state: "new",
                fingerprint,
                expected: None,
            })
            .await;
        } else {
            let _ = send(ServerMsg::Hostkey {
                session_id: session_id.clone(),
                state: "verified",
                fingerprint,
                expected: None,
            })
            .await;
        }
    }

    let channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(e) => {
            let message = format!("shell: {e}");
            let _ = send(ServerMsg::Error {
                session_id,
                message: message.clone(),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return;
        }
    };
    if let Err(e) = channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
    {
        let message = format!("shell: {e}");
        let _ = send(ServerMsg::Error {
            session_id,
            message: message.clone(),
        })
        .await;
        state.add_audit("session.error", Some(host.id), &message);
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return;
    }
    // Parity: ssh2 `{ agentForward: true }` shell option.
    if host.agent_forward {
        if let Err(e) = channel.agent_forward(true).await {
            let message = format!("shell: {e}");
            let _ = send(ServerMsg::Error {
                session_id,
                message: message.clone(),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
            return;
        }
    }
    if let Err(e) = channel.request_shell(true).await {
        let message = format!("shell: {e}");
        let _ = send(ServerMsg::Error {
            session_id,
            message: message.clone(),
        })
        .await;
        state.add_audit("session.error", Some(host.id), &message);
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return;
    }

    state.add_audit(
        "session.start",
        Some(host.id),
        &format!(
            "{} ({}:{}){}",
            host.name,
            host.host,
            host.port,
            if host.agent_forward { " agent-fwd" } else { "" }
        ),
    );
    let _ = send(ServerMsg::Status {
        session_id: session_id.clone(),
        state: "connected",
        detail: None,
    })
    .await;

    // Parity: `void startAutoForwards(host.id)` on connect.
    {
        let state = state.clone();
        let host_id = host.id;
        tokio::spawn(async move {
            crate::forwards::start_auto_forwards(&state, host_id).await;
        });
    }

    let (mut rd, wr) = channel.split();
    let session_id_out = session_id.clone();
    let audit_host = host.id;
    let audit_name = host.name.clone();
    loop {
        let msg = tokio::select! {
            _ = shutdown.notified() => None,
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCmd::Input(data)) => {
                        let _ = wr.data_bytes(Bytes::from(data.into_bytes())).await;
                        continue;
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let _ = wr.window_change(cols, rows, 0, 0).await;
                        continue;
                    }
                    None => None,
                }
            }
            msg = rd.wait() => msg,
        };
        match msg {
            Some(ChannelMsg::Data { data }) => {
                let _ = out_tx
                    .send(ServerMsg::Output {
                        session_id: session_id_out.clone(),
                        data: B64.encode(&data),
                    })
                    .await;
            }
            // Old server ignored stderr (ssh2 'data' only fires on stdout).
            Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                let _ = out_tx
                    .send(ServerMsg::Exit {
                        session_id: session_id_out.clone(),
                        code: Some(exit_status as i64),
                    })
                    .await;
                state.add_audit(
                    "session.end",
                    Some(audit_host),
                    &format!("{audit_name} exit={exit_status}"),
                );
                break;
            }
            Some(ChannelMsg::ExitSignal { .. }) => {
                let _ = out_tx
                    .send(ServerMsg::Exit {
                        session_id: session_id_out.clone(),
                        code: None,
                    })
                    .await;
                state.add_audit(
                    "session.end",
                    Some(audit_host),
                    &format!("{audit_name} exit=null"),
                );
                break;
            }
            Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }

    let _ = wr.eof().await;
    let _ = wr.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    record_close(&state, host.id);
}

async fn run_telnet(
    state: AppState,
    session_id: String,
    host: Host,
    mut cmd_rx: mpsc::Receiver<SessionCmd>,
    shutdown: Arc<Notify>,
    out_tx: mpsc::Sender<ServerMsg>,
) {
    let send = {
        let out_tx = out_tx.clone();
        move |msg: ServerMsg| {
            let out_tx = out_tx.clone();
            async move {
                let _ = out_tx.send(msg).await;
            }
        }
    };

    let addr = format!("{}:{}", host.host, host.port);
    let stream = match tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    {
        Err(_) => {
            let message = format!("telnet {addr}: connection timed out");
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some(message.clone()),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
        Ok(Err(e)) => {
            let message = format!("telnet {addr}: {e}");
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some(message.clone()),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
        Ok(Ok(stream)) => stream,
    };
    stream.set_nodelay(true).ok();
    let (mut rd, mut wr) = stream.into_split();
    let mut filter = ssh::TelnetFilter::new();

    state.add_audit("session.start", Some(host.id), &format!("telnet {addr}"));
    let _ = send(ServerMsg::Status {
        session_id: session_id.clone(),
        state: "connected",
        detail: None,
    })
    .await;

    let session_id_out = session_id.clone();
    let mut buf = vec![0u8; 16384];
    loop {
        let msg: Option<SessionCmd> = tokio::select! {
            _ = shutdown.notified() => None,
            cmd = cmd_rx.recv() => cmd,
            read = rd.read(&mut buf) => {
                match read {
                    Ok(0) => None,
                    Ok(n) => {
                        let (payload, reply) = filter.push(&buf[..n]);
                        if !payload.is_empty() {
                            let _ = out_tx.send(ServerMsg::Output {
                                session_id: session_id_out.clone(),
                                data: B64.encode(&payload),
                            }).await;
                        }
                        if !reply.is_empty() {
                            let _ = wr.write_all(&reply).await;
                        }
                        continue;
                    }
                    Err(_) => None,
                }
            }
        };
        match msg {
            Some(SessionCmd::Input(data)) => {
                let _ = wr.write_all(data.as_bytes()).await;
            }
            // No window resize over telnet (parity).
            Some(SessionCmd::Resize { .. }) => {}
            None => break,
        }
    }

    let _ = out_tx
        .send(ServerMsg::Exit {
            session_id,
            code: None,
        })
        .await;
    drop(wr);
    record_close(&state, host.id);
}

async fn run_mosh(
    state: AppState,
    session_id: String,
    host: Host,
    mut cmd_rx: mpsc::Receiver<SessionCmd>,
    shutdown: Arc<Notify>,
    out_tx: mpsc::Sender<ServerMsg>,
) {
    let send = {
        let out_tx = out_tx.clone();
        move |msg: ServerMsg| {
            let out_tx = out_tx.clone();
            async move {
                let _ = out_tx.send(msg).await;
            }
        }
    };

    if !ssh::has_mosh() {
        let detail =
            "mosh-client/mosh-server binaries not found on the server host".to_string();
        let _ = send(ServerMsg::Status {
            session_id,
            state: "error",
            detail: Some(detail.clone()),
        })
        .await;
        state.add_audit("session.error", Some(host.id), &detail);
        return;
    }

    let child = tokio::process::Command::new("mosh-client")
        .arg(&host.host)
        .arg(host.port.to_string())
        .env("TERM", "xterm-256color")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            let message = format!("mosh {}:{}: {e}", host.host, host.port);
            let _ = send(ServerMsg::Status {
                session_id,
                state: "error",
                detail: Some(message.clone()),
            })
            .await;
            state.add_audit("session.error", Some(host.id), &message);
            return;
        }
    };

    state.add_audit(
        "session.start",
        Some(host.id),
        &format!("mosh {}:{}", host.host, host.port),
    );
    let _ = send(ServerMsg::Status {
        session_id: session_id.clone(),
        state: "connected",
        detail: None,
    })
    .await;

    let mut stdout = child.stdout.take();
    let mut stdin = child.stdin.take();
    let session_id_out = session_id.clone();
    let mut buf = vec![0u8; 16384];
    let exit_code: Option<i64> = loop {
        tokio::select! {
            _ = shutdown.notified() => break None,
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCmd::Input(data)) => {
                        if let Some(stdin) = stdin.as_mut() {
                            let _ = stdin.write_all(data.as_bytes()).await;
                        }
                    }
                    // mosh handles resize internally.
                    Some(SessionCmd::Resize { .. }) => {}
                    None => break None,
                }
            }
            read = async {
                match stdout.as_mut() {
                    Some(stdout) => stdout.read(&mut buf).await,
                    None => std::future::pending().await,
                }
            } => {
                match read {
                    Ok(0) => break None,
                    Ok(n) => {
                        let _ = out_tx.send(ServerMsg::Output {
                            session_id: session_id_out.clone(),
                            data: B64.encode(&buf[..n]),
                        }).await;
                    }
                    Err(_) => break None,
                }
            }
            status = child.wait() => {
                break status.ok().map(|s| s.code().unwrap_or(0) as i64);
            }
        }
    };

    let _ = out_tx
        .send(ServerMsg::Exit {
            session_id,
            code: exit_code,
        })
        .await;
    let _ = child.start_kill();
    record_close(&state, host.id);
}
