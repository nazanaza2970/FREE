//! VNC tests (M5): config resolution, diagnostics parsing, and a full
//! `/ws/vnc` binary tunnel over the `direct` transport to a fake RFB server.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use free::crypto::Keystore;
use free::db;
use free::models::HostInput;
use free::state::{AppState, SessionEntry};
use free::tokens;
use free::vnc;

fn test_state() -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "free-vnc-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = db::init_db(&dir.join("test.db")).unwrap();
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
    (state, dir)
}

/// A fake RFB server: sends the protocol greeting, then echoes any bytes.
async fn spawn_rfb_server() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let _ = socket.write_all(b"RFB 003.008\n").await;
                let mut buf = vec![0u8; 4096];
                loop {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut echo = b"echo:".to_vec();
                            echo.extend_from_slice(&buf[..n]);
                            if socket.write_all(&echo).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

#[test]
fn parse_diagnostics_identifies_environment() {
    let output = "\
==os==
Ubuntu 24.04.1 LTS
==arch==
x86_64
==bins==
/usr/bin/vncserver
/usr/bin/x11vnc
==version==
TigerVNC Viewer 1.13.1
==listen==
5900
5901
==processes==
/usr/bin/Xvnc :2 -geometry 1280x800
==xsessions==
xfce.desktop
==sessiontype==
Type=x11
==display==
:0
==xdisplays==
0
2
==uid==
1000";
    let diagnostics = vnc::parse_diagnostics(output, 5900);
    assert_eq!(diagnostics.os, "Ubuntu 24.04.1 LTS");
    assert_eq!(diagnostics.architecture.as_deref(), Some("x86_64"));
    assert!(diagnostics.vnc.installed);
    assert!(diagnostics.vnc.running);
    assert!(diagnostics.vnc.has_x11vnc);
    assert_eq!(diagnostics.vnc.implementation.as_deref(), Some("tigervnc"));
    assert_eq!(diagnostics.vnc.port, Some(5900));
    assert_eq!(diagnostics.vnc.display, Some(2));
    assert_eq!(diagnostics.desktop.environment.as_deref(), Some("xfce"));
    assert_eq!(diagnostics.desktop.display_server.as_deref(), Some("x11"));
    assert_eq!(diagnostics.desktop.display.as_deref(), Some(":0"));
    assert_eq!(diagnostics.desktop.displays.as_deref(), Some(&[0i64, 2][..]));
    assert!(diagnostics.desktop.installed);
    assert!(diagnostics.permissions.can_access_display);
    let (state, dir) = test_state();
    let host = state
        .with_db(|c| {
            db::create_host(
                c,
                &HostInput {
                    name: Some("vnc".into()),
                    host: Some("127.0.0.1".into()),
                    port: Some(5900),
                    username: Some("tester".into()),
                    connection_type: Some("vnc".into()),
                    ..<_>::default()
                },
            )
        })
        .unwrap();
    assert_eq!(
        vnc::resolve_implementation(Some(&diagnostics), &host),
        "x11vnc"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn requirements_block_when_server_missing() {
    let output = "\
==os==
Debian GNU/Linux 12
==arch==
aarch64
==bins==
==version==
==listen==
==processes==
==xsessions==
==sessiontype==
==display==
==xdisplays==
==uid==
1000";
    let diagnostics = vnc::parse_diagnostics(output, 5900);
    assert!(!diagnostics.vnc.installed);
    assert!(!diagnostics.desktop.installed);
    let requirements = vnc::get_vnc_requirements(Some(&diagnostics), "tigervnc");
    let kinds: Vec<&str> = requirements.iter().map(|r| r.kind.as_str()).collect();
    assert!(kinds.contains(&"vnc_server_missing"), "{kinds:?}");
    assert!(kinds.contains(&"desktop_missing"), "{kinds:?}");
    let vnc_req = requirements
        .iter()
        .find(|r| r.kind == "vnc_server_missing")
        .unwrap();
    assert_eq!(vnc_req.severity, "blocking");
    assert!(vnc_req
        .install_commands
        .as_ref()
        .unwrap()
        .iter()
        .any(|c| c.contains("apt-get")));
}

#[test]
fn requirements_empty_when_probe_would_be_running() {
    let diagnostics = vnc::VncDiagnostics {
        os: "Fedora".into(),
        distribution: Some("Fedora".into()),
        architecture: Some("x86_64".into()),
        vnc: vnc::VncDiagVnc {
            installed: true,
            running: true,
            implementation: Some("tigervnc".into()),
            has_x11vnc: false,
            port: Some(5900),
            display: Some(1),
        },
        desktop: vnc::VncDiagDesktop {
            installed: true,
            environment: Some("gnome".into()),
            display_server: Some("x11".into()),
            display: Some(":1".into()),
            displays: Some(vec![1]),
        },
        permissions: vnc::VncDiagPermissions {
            can_start_vnc: true,
            can_access_display: true,
        },
        requirements: vec![],
    };
    assert!(vnc::get_vnc_requirements(Some(&diagnostics), "tigervnc").is_empty());
}

#[test]
fn resolve_config_defaults_to_ssh_transport() {
    let (state, dir) = test_state();
    let host = state
        .with_db(|c| {
            db::create_host(
                c,
                &HostInput {
                    name: Some("vnc".into()),
                    host: Some("127.0.0.1".into()),
                    port: Some(5900),
                    username: Some("tester".into()),
                    connection_type: Some("vnc".into()),
                    ..<_>::default()
                },
            )
        })
        .unwrap();
    let cfg = vnc::resolve_vnc_config(&state, &host);
    assert_eq!(cfg.transport, "ssh");
    assert_eq!(cfg.vnc_port, 5900);
    assert_eq!(cfg.vnc_host, "127.0.0.1");
    assert!(cfg.ssh.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn vnc_ws_binary_tunnel_direct() {
    let (state, dir) = test_state();
    let rfb_port = spawn_rfb_server().await;
    let (_token, hash) = tokens::generate_token();
    let token = {
        let (t, h) = tokens::generate_token();
        state
            .with_db(|c| db::create_app_password(c, "e2e", "*", &h))
            .unwrap();
        t
    };
    drop(hash);

    let host = state
        .with_db(|c| {
            db::create_host(
                c,
                &HostInput {
                    name: Some("vnc-direct".into()),
                    host: Some("127.0.0.1".into()),
                    port: Some(rfb_port as i64),
                    connection_type: Some("vnc".into()),
                    vnc_transport: Some("direct".into()),
                    ..<_>::default()
                },
            )
        })
        .unwrap();

    let router = free::api::router(state.clone());
    let api_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_port = api_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(api_listener, router).await;
    });

    // --- status endpoint sees the running probe --------------------------
    let http = reqwest_status(api_port, &token, host.id).await;
    assert_eq!(http["running"], serde_json::json!(true));
    assert_eq!(http["port"], serde_json::json!(rfb_port));
    assert_eq!(http["transport"], serde_json::json!("direct"));

    // --- binary tunnel ---------------------------------------------------
    let url = format!("ws://127.0.0.1:{api_port}/ws/vnc?host_id={}&token={token}", host.id);
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("ws connect");
    let (mut sink, mut stream) = ws.split();

    // First frame is the RFB greeting forwarded from the backend.
    let greeting = next_binary(&mut stream).await;
    assert_eq!(&greeting[..4], b"RFB ");

    // Send client bytes; fake server prefixes with "echo:".
    sink.send(WsMessage::Binary(b"client-hello".to_vec().into()))
        .await
        .unwrap();
    let echoed = next_binary(&mut stream).await;
    assert_eq!(&echoed[..5], b"echo:");
    assert_eq!(&echoed[5..], b"client-hello");

    sink.send(WsMessage::Close(None)).await.unwrap();

    let actions: Vec<String> = state
        .with_db(|c| db::list_audit(c, 50).unwrap())
        .into_iter()
        .map(|r| r.action)
        .collect();
    assert!(actions.iter().any(|a| a == "vnc.connect"), "{actions:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn vnc_ws_rejects_bad_token() {
    let (state, dir) = test_state();
    let (_token, hash) = tokens::generate_token();
    state
        .with_db(|c| db::create_app_password(c, "e2e", "*", &hash))
        .unwrap();
    let router = free::api::router(state);
    let api_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let api_port = api_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(api_listener, router).await;
    });
    let url = format!("ws://127.0.0.1:{api_port}/ws/vnc?host_id=1&token=tfp_bogus");
    assert!(tokio_tungstenite::connect_async(&url).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

async fn next_binary(
    stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Vec<u8> {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
            .await
            .expect("timed out waiting for ws frame")
            .expect("ws stream ended")
            .expect("ws frame error");
        match frame {
            WsMessage::Binary(data) => return data.to_vec(),
            WsMessage::Close(_) => panic!("unexpected close"),
            _ => continue,
        }
    }
}

async fn reqwest_status(api_port: u16, token: &str, host_id: i64) -> serde_json::Value {
    let mut stream = TcpStream::connect(("127.0.0.1", api_port)).await.unwrap();
    let request = format!(
        "GET /api/vnc/{host_id}/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let text = String::from_utf8_lossy(&response);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    serde_json::from_str(body.trim()).expect("valid json body")
}
