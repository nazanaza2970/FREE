//! End-to-end `/ws/terminal` test: a russh echo server, the real axum router,
//! and a WebSocket client exercising connect → hostkey TOFU → shell →
//! input/output → exit, plus reconnect = "verified".

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session as ServerSession};
use russh::{Channel, ChannelId, Preferred};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use free::crypto::Keystore;
use free::db;
use free::models::HostInput;
use free::state::{AppState, SessionEntry};
use free::tokens;

struct EchoServer;

impl russh::server::Server for EchoServer {
    type Handler = EchoHandler;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> EchoHandler {
        EchoHandler
    }

    fn handle_session_error(&mut self, _error: <EchoHandler as russh::server::Handler>::Error) {}
}

struct EchoHandler;

impl russh::server::Handler for EchoHandler {
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
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        let _ = session.data(channel, &b"welcome\r\n"[..]);
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        if data == b"exit\r" || data == b"exit\n" {
            let _ = session.exit_status_request(channel, 7);
            let _ = session.eof(channel);
            let _ = session.close(channel);
            return Ok(());
        }
        let mut out = b"echo:".to_vec();
        out.extend_from_slice(data);
        let _ = session.data(channel, out);
        Ok(())
    }
}

async fn next_json(stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin)) -> Value {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
            .await
            .expect("timed out waiting for ws frame")
            .expect("ws stream ended");
        let frame = frame.expect("ws frame error");
        if let WsMessage::Text(text) = frame {
            return serde_json::from_str(&text).expect("valid json frame");
        }
        // ignore ping/pong/binary
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_ws_full_session() {
    // --- russh echo server on an ephemeral port -------------------------
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
    let mut server = EchoServer;
    tokio::spawn(async move {
        let _ = server.run_on_socket(ssh_config, &ssh_listener).await;
    });

    // --- app state with a temp database ---------------------------------
    let dir = std::env::temp_dir().join(format!("free-ws-test-{}", std::process::id()));
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
        sessions: Arc::new(Mutex::new(std::collections::HashMap::<String, SessionEntry>::new())),
        recent_closes: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let host = state
        .with_db(|c| {
            db::create_host(
                c,
                &HostInput {
                    name: Some("echo".into()),
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
    let url = format!("ws://127.0.0.1:{api_port}/ws/terminal?token={token}");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("ws connect");
    let (mut sink, mut stream) = ws.split();

    let sid = "sess-1";
    sink.send(WsMessage::Text(
        json!({"type": "connect", "sessionId": sid, "hostId": host.id}).to_string().into(),
    ))
    .await
    .unwrap();

    let mut saw_connected = false;
    let mut saw_hostkey_new = false;
    let mut output = Vec::new();
    let mut exit_code = None;
    let mut sent_exit = false;
    while exit_code.is_none() {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "status" => {
                assert_eq!(frame["sessionId"].as_str().unwrap(), sid);
                let state_name = frame["state"].as_str().unwrap();
                if state_name == "connected" {
                    saw_connected = true;
                    sink.send(WsMessage::Text(
                        json!({"type": "input", "sessionId": sid, "data": "exit\r"})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                    sent_exit = true;
                }
                assert_ne!(state_name, "error", "status error: {frame}");
            }
            "hostkey" => {
                assert_eq!(frame["state"].as_str().unwrap(), "new");
                assert!(frame["fingerprint"]
                    .as_str()
                    .unwrap()
                    .starts_with("SHA256:"));
                saw_hostkey_new = true;
            }
            "output" => {
                let data = frame["data"].as_str().unwrap();
                output.push(base64_decode(data));
            }
            "exit" => {
                exit_code = frame["code"].as_i64();
            }
            other => panic!("unexpected frame: {other}: {frame}"),
        }
    }

    assert!(saw_connected && sent_exit, "never saw status connected");
    assert_eq!(exit_code, Some(7), "sess-1 exit status should round-trip");
    assert!(saw_hostkey_new, "never saw hostkey new");
    // welcome banner + echo of our input
    let output: Vec<u8> = output.concat();
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("welcome"), "banner missing: {output}");
    assert!(
        state.with_db(|c| db::get_known_host(c, "127.0.0.1", ssh_port as i64))
            .unwrap()
            .is_some(),
        "TOFU did not store the host key"
    );

    // --- input echo round trip ------------------------------------------
    sink.send(WsMessage::Text(
        json!({"type": "connect", "sessionId": "sess-2", "hostId": host.id})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let mut verified = false;
    loop {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "hostkey" => {
                assert_eq!(frame["state"].as_str().unwrap(), "verified");
                verified = true;
            }
            "status" if frame["state"] == "connected" => {
                break;
            }
            "status" if frame["state"] == "error" => {
                // session already active is fine if we raced; fail otherwise
                panic!("status error: {frame}");
            }
            _ => {}
        }
    }
    assert!(verified, "second connect should be hostkey verified");

    sink.send(WsMessage::Text(
        json!({"type": "input", "sessionId": "sess-2", "data": "hello-from-test\r"})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();

    let mut echoed = String::new();
    while !echoed.contains("hello-from-test") {
        let frame = next_json(&mut stream).await;
        match frame["type"].as_str().unwrap() {
            "output" => echoed.push_str(&String::from_utf8_lossy(&base64_decode(frame["data"].as_str().unwrap()))),
            "exit" => panic!("exited before echo: {frame}"),
            _ => {}
        }
    }

    sink.send(WsMessage::Text(
        json!({"type": "input", "sessionId": "sess-2", "data": "exit\r"})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let mut code = None;
    while code.is_none() {
        let frame = next_json(&mut stream).await;
        if frame["type"] == "exit" {
            code = frame["code"].as_i64();
        }
    }
    assert_eq!(code, Some(7), "exit status should round-trip");

    // audit trail
    let actions: Vec<String> = state
        .with_db(|c| db::list_audit(c, 50).unwrap())
        .into_iter()
        .map(|r| r.action)
        .collect();
    assert!(actions.iter().any(|a| a == "hostkey.trusted"), "{actions:?}");
    assert!(actions.iter().any(|a| a == "session.start"), "{actions:?}");
    assert!(actions.iter().any(|a| a == "session.end"), "{actions:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_ws_rejects_bad_token() {
    let dir = std::env::temp_dir().join(format!("free-ws-auth-{}", std::process::id()));
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
        sessions: Arc::new(Mutex::new(std::collections::HashMap::<String, SessionEntry>::new())),
        recent_closes: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let router = free::api::router(state);
    let api_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_port = api_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(api_listener, router).await;
    });

    let url = format!("ws://127.0.0.1:{api_port}/ws/terminal?token=tfp_bogus");
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(result.is_err(), "bogus token must be rejected");
    let _ = std::fs::remove_dir_all(&dir);
}

fn base64_decode(data: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("valid base64 in output frames")
}
