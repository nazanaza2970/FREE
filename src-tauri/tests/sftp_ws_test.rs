//! End-to-end `/ws/sftp` test: a russh server with an in-memory SFTP
//! subsystem, the real axum router, and a WebSocket client exercising
//! open → upload → list → download → mkdir → rename → stat → remove.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session as ServerSession};
use russh::{Channel, ChannelId, Preferred};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use free::crypto::Keystore;
use free::db;
use free::models::HostInput;
use free::state::{AppState, SessionEntry};
use free::tokens;

// ---------------------------------------------------------------------------
// Minimal in-memory SFTP filesystem (russh-sftp server Handler).
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MemFs {
    files: HashMap<String, Vec<u8>>,
    dirs: Vec<String>,
    next_handle: u32,
    read_handles: HashMap<String, Vec<File>>,
    write_handles: HashMap<String, String>,
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

fn dir_attrs() -> FileAttributes {
    let mut a = FileAttributes::default();
    a.set_dir(true);
    a
}

fn file_attrs(size: u64) -> FileAttributes {
    let mut a = FileAttributes::default();
    a.set_regular(true);
    a.size = Some(size);
    a
}

impl MemFs {
    fn is_dir(&self, path: &str) -> bool {
        path == "/" || self.dirs.iter().any(|d| d == path)
    }

    fn entries_of(&self, path: &str) -> Vec<File> {
        let mut out = Vec::new();
        for dir in &self.dirs {
            if let Some(name) = dir.rsplit('/').next() {
                let parent = &dir[..dir.len() - name.len() - 1];
                let parent = if parent.is_empty() { "/" } else { parent };
                if parent == path {
                    out.push(File::new(name, dir_attrs()));
                }
            }
        }
        for (fpath, data) in &self.files {
            if let Some(name) = fpath.rsplit('/').next() {
                let parent = &fpath[..fpath.len() - name.len() - 1];
                let parent = if parent.is_empty() { "/" } else { parent };
                if parent == path {
                    out.push(File::new(name, file_attrs(data.len() as u64)));
                }
            }
        }
        out
    }

    fn take_handle(&mut self) -> String {
        self.next_handle += 1;
        format!("h{}", self.next_handle)
    }
}

impl russh_sftp::server::Handler for MemFs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = if path == "." || path.is_empty() {
            "/".to_string()
        } else {
            path
        };
        Ok(Name {
            id,
            files: vec![File::dummy(&resolved)],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        if self.is_dir(&path) {
            return Ok(Attrs { id, attrs: dir_attrs() });
        }
        if let Some(data) = self.files.get(&path) {
            return Ok(Attrs { id, attrs: file_attrs(data.len() as u64) });
        }
        Err(StatusCode::NoSuchFile)
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        if !self.is_dir(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.take_handle();
        let entries = self.entries_of(&path);
        self.read_handles.insert(handle.clone(), entries);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.read_handles.get_mut(&handle) {
            Some(entries) if !entries.is_empty() => {
                let files = std::mem::take(entries);
                Ok(Name { id, files })
            }
            Some(_) => Err(StatusCode::Eof),
            None => Err(StatusCode::Failure),
        }
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let write = pflags.contains(OpenFlags::WRITE);
        if write {
            if pflags.contains(OpenFlags::TRUNCATE) || !self.files.contains_key(&filename) {
                if !pflags.contains(OpenFlags::CREATE) && !self.files.contains_key(&filename) {
                    return Err(StatusCode::NoSuchFile);
                }
                self.files.insert(filename.clone(), Vec::new());
            }
            let handle = self.take_handle();
            self.write_handles.insert(handle.clone(), filename);
            return Ok(Handle { id, handle });
        }
        if self.files.contains_key(&filename) {
            let handle = self.take_handle();
            self.write_handles.insert(format!("r{handle}"), filename);
            return Ok(Handle { id, handle });
        }
        Err(StatusCode::NoSuchFile)
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.read_handles.remove(&handle);
        self.write_handles.remove(&handle);
        self.write_handles.remove(&format!("r{handle}"));
        Ok(ok_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let key = format!("r{handle}");
        let path = self
            .write_handles
            .get(&key)
            .cloned()
            .ok_or(StatusCode::Failure)?;
        let data = self.files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        let start = offset as usize;
        if start >= data.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(data.len());
        Ok(Data { id, data: data[start..end].to_vec() })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self
            .write_handles
            .get(&handle)
            .cloned()
            .ok_or(StatusCode::Failure)?;
        let file = self.files.entry(path).or_default();
        let start = offset as usize;
        if file.len() < start + data.len() {
            file.resize(start + data.len(), 0);
        }
        file[start..start + data.len()].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        if self.is_dir(&path) {
            return Err(StatusCode::Failure);
        }
        self.dirs.push(path);
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let before = self.dirs.len();
        self.dirs.retain(|d| d != &path);
        if self.dirs.len() == before {
            return Err(StatusCode::Failure);
        }
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        if self.files.remove(&filename).is_none() {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(ok_status(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        if let Some(data) = self.files.remove(&oldpath) {
            self.files.insert(newpath, data);
            return Ok(ok_status(id));
        }
        if let Some(pos) = self.dirs.iter().position(|d| d == &oldpath) {
            self.dirs.remove(pos);
            self.dirs.push(newpath);
            return Ok(ok_status(id));
        }
        Err(StatusCode::NoSuchFile)
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }

    async fn symlink(
        &mut self,
        id: u32,
        _linkpath: String,
        _targetpath: String,
    ) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }

    async fn readlink(&mut self, _id: u32, _path: String) -> Result<Name, Self::Error> {
        Err(StatusCode::OpUnsupported)
    }
}

// ---------------------------------------------------------------------------
// russh server exposing the MemFs via the "sftp" subsystem.
// ---------------------------------------------------------------------------

struct SftpServer;

impl russh::server::Server for SftpServer {
    type Handler = SftpServerHandler;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> SftpServerHandler {
        SftpServerHandler {
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn handle_session_error(&mut self, _error: <SftpServerHandler as russh::server::Handler>::Error) {
    }
}

struct SftpServerHandler {
    clients: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl russh::server::Handler for SftpServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "tester" && password == "hunter2" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        self.clients
            .lock()
            .unwrap()
            .insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.clients.lock().unwrap().remove(&channel_id).unwrap();
            session.channel_success(channel_id)?;
            russh_sftp::server::run(channel.into_stream(), MemFs::default()).await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Shared test helpers.
// ---------------------------------------------------------------------------

async fn next_json(
    stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
              + Unpin),
) -> Value {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
            .await
            .expect("timed out waiting for ws frame")
            .expect("ws stream ended");
        let frame = frame.expect("ws frame error");
        if let WsMessage::Text(text) = frame {
            return serde_json::from_str(&text).expect("valid json frame");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_ws_full_session() {
    // --- russh SFTP server on an ephemeral port -------------------------
    let ssh_config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap()],
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        preferred: Preferred::default(),
        ..<_>::default()
    });
    let ssh_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let ssh_port = ssh_listener.local_addr().unwrap().port();
    let mut server = SftpServer;
    tokio::spawn(async move {
        let _ = server.run_on_socket(ssh_config, &ssh_listener).await;
    });

    // --- app state with a temp database ---------------------------------
    let dir = std::env::temp_dir().join(format!("free-sftp-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = db::init_db(&dir.join("test.db")).unwrap();
    let (token, hash) = tokens::generate_token();
    db::create_app_password(&conn, "e2e", "*", &hash).unwrap();
    let keystore = Keystore::load(&dir).unwrap();
    let (audit_tx, _) = tokio::sync::broadcast::channel(64);
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        keystore: Arc::new(keystore),
        audit_tx,
        bootstrap_token: None,
        api_base: String::new(),
        sessions: Arc::new(Mutex::new(HashMap::<String, SessionEntry>::new())),
        recent_closes: Arc::new(Mutex::new(HashMap::new())),
    };
    let host = state
        .with_db(|c| {
            db::create_host(
                c,
                &HostInput {
                    name: Some("sftp".into()),
                    host: Some("127.0.0.1".into()),
                    port: Some(ssh_port as i64),
                    username: Some("tester".into()),
                    auth_method: Some("password".into()),
                    password: Some(Some("hunter2".into())),
                    ..<_>::default()
                },
            )
        })
        .unwrap();

    // --- real API router ------------------------------------------------
    let router = free::api::router(state.clone());
    let api_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_port = api_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(api_listener, router).await;
    });

    // --- WebSocket client -----------------------------------------------
    let url = format!("ws://127.0.0.1:{api_port}/ws/sftp?token={token}");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("ws connect");
    let (mut sink, mut stream) = ws.split();

    sink.send(WsMessage::Text(
        json!({"type": "open", "hostId": host.id}).to_string().into(),
    ))
    .await
    .unwrap();

    let mut opened = false;
    while !opened {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "opened" => {
                assert_eq!(frame["cwd"], "/");
                opened = true;
            }
            "error" => panic!("open failed: {frame}"),
            _ => {}
        }
    }

    // --- upload ---------------------------------------------------------
    let payload = b"hello world";
    sink.send(WsMessage::Text(
        json!({"type": "upload-start", "id": "u1", "path": "/hello.txt", "size": payload.len()})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let mut got_progress0 = false;
    while !got_progress0 {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "progress" if frame["id"] == "u1" && frame["transferred"] == 0 => {
                got_progress0 = true;
            }
            "error" => panic!("upload-start failed: {frame}"),
            _ => {}
        }
    }
    sink.send(WsMessage::Text(
        json!({"type": "upload-chunk", "id": "u1", "data": B64.encode(payload)}).to_string().into(),
    ))
    .await
    .unwrap();
    sink.send(WsMessage::Text(
        json!({"type": "upload-end", "id": "u1"}).to_string().into(),
    ))
    .await
    .unwrap();
    let mut upload_done = None;
    while upload_done.is_none() {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "done" if frame["id"] == "u1" => upload_done = Some(frame),
            "error" => panic!("upload failed: {frame}"),
            _ => {}
        }
    }
    let done = upload_done.unwrap();
    assert_eq!(done["op"], "upload");
    assert_eq!(done["bytes"], payload.len() as i64);

    // --- list -----------------------------------------------------------
    sink.send(WsMessage::Text(
        json!({"type": "list", "path": "/"}).to_string().into(),
    ))
    .await
    .unwrap();
    let mut list_ok = false;
    while !list_ok {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "entries" if frame["path"] == "/" => {
                let entries = frame["entries"].as_array().unwrap();
                assert_eq!(entries.len(), 1, "root should contain one file: {frame}");
                assert_eq!(entries[0]["name"], "hello.txt");
                assert_eq!(entries[0]["path"], "/hello.txt");
                assert_eq!(entries[0]["type"], "file");
                assert_eq!(entries[0]["size"], payload.len() as i64);
                list_ok = true;
            }
            "error" => panic!("list failed: {frame}"),
            _ => {}
        }
    }

    // --- download -------------------------------------------------------
    sink.send(WsMessage::Text(
        json!({"type": "download-start", "id": "d1", "path": "/hello.txt"}).to_string().into(),
    ))
    .await
    .unwrap();
    let mut downloaded: Vec<u8> = Vec::new();
    let mut download_done: Option<Value> = None;
    while download_done.is_none() {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "data" if frame["id"] == "d1" => {
                downloaded.extend(B64.decode(frame["data"].as_str().unwrap()).unwrap());
            }
            "done" if frame["id"] == "d1" => download_done = Some(frame),
            "error" => panic!("download failed: {frame}"),
            _ => {}
        }
    }
    assert_eq!(downloaded, payload);
    assert_eq!(download_done.unwrap()["bytes"], payload.len() as i64);

    // --- mkdir / rename / stat -------------------------------------------
    sink.send(WsMessage::Text(
        json!({"type": "mkdir", "path": "/dir"}).to_string().into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = next_json(&mut stream).await;
        if frame["type"] == "ok" && frame["op"] == "mkdir" {
            break;
        }
        assert_ne!(frame["type"], "error", "mkdir failed: {frame}");
    }
    sink.send(WsMessage::Text(
        json!({"type": "rename", "from": "/hello.txt", "to": "/dir/renamed.txt"})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = next_json(&mut stream).await;
        if frame["type"] == "ok" && frame["op"] == "rename" {
            break;
        }
        assert_ne!(frame["type"], "error", "rename failed: {frame}");
    }
    sink.send(WsMessage::Text(
        json!({"type": "stat", "path": "/dir/renamed.txt"}).to_string().into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "entry" => {
                let entry = &frame["entry"];
                assert_eq!(entry["name"], "renamed.txt");
                assert_eq!(entry["path"], "/dir/renamed.txt");
                assert_eq!(entry["type"], "file");
                assert_eq!(entry["size"], payload.len() as i64);
                break;
            }
            "error" => panic!("stat failed: {frame}"),
            _ => {}
        }
    }

    // --- remove recursive -------------------------------------------------
    sink.send(WsMessage::Text(
        json!({"type": "remove", "path": "/dir", "recursive": true}).to_string().into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = next_json(&mut stream).await;
        if frame["type"] == "ok" && frame["op"] == "remove" {
            break;
        }
        assert_ne!(frame["type"], "error", "remove failed: {frame}");
    }

    // --- audit trail -------------------------------------------------------
    let actions: Vec<String> = state
        .with_db(|c| db::list_audit(c, 50).unwrap())
        .into_iter()
        .map(|r| r.action)
        .collect();
    for expected in [
        "hostkey.trusted",
        "sftp.connect",
        "sftp.upload",
        "sftp.download",
        "sftp.mkdir",
        "sftp.rename",
        "sftp.remove",
    ] {
        assert!(actions.iter().any(|a| a == expected), "missing {expected}: {actions:?}");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_ws_rejects_bad_token() {
    let dir = std::env::temp_dir().join(format!("free-sftp-auth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = db::init_db(&dir.join("test.db")).unwrap();
    let (_token, hash) = tokens::generate_token();
    db::create_app_password(&conn, "e2e", "*", &hash).unwrap();
    let keystore = Keystore::load(&dir).unwrap();
    let (audit_tx, _) = tokio::sync::broadcast::channel(8);
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        keystore: Arc::new(keystore),
        audit_tx,
        bootstrap_token: None,
        api_base: String::new(),
        sessions: Arc::new(Mutex::new(HashMap::<String, SessionEntry>::new())),
        recent_closes: Arc::new(Mutex::new(HashMap::new())),
    };
    let router = free::api::router(state);
    let api_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_port = api_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(api_listener, router).await;
    });

    let url = format!("ws://127.0.0.1:{api_port}/ws/sftp?token=tfp_bogus");
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(result.is_err(), "bogus token must be rejected");
    let _ = std::fs::remove_dir_all(&dir);
}
