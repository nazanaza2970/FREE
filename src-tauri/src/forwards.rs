//! Port-forward engine (parity with `server/forwards.ts`): local, SOCKS5 and
//! remote forwards over one shared SSH tunnel per host. The tunnel map is
//! module-level state, exactly like the old TS module.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use russh::ChannelMsg;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::db;
use crate::models::PortForward;
use crate::ssh::{self, FwdHandle, FwdHandler};
use crate::state::AppState;

enum Active {
    Local { abort: tokio::task::AbortHandle },
    Socks { abort: tokio::task::AbortHandle },
    Remote { bind_port: u16 },
}

struct Tunnel {
    handle: Arc<FwdHandle>,
    active: HashMap<i64, Active>,
    remote_targets: Arc<Mutex<HashMap<u16, (String, u32)>>>,
}

fn tunnels() -> &'static Mutex<HashMap<i64, Tunnel>> {
    static TUNNELS: OnceLock<Mutex<HashMap<i64, Tunnel>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn find_forward(state: &AppState, id: i64) -> Option<PortForward> {
    state
        .with_db(|conn| db::list_forwards(conn, None).ok())
        .unwrap_or_default()
        .into_iter()
        .find(|f| f.id == id)
}

async fn connect_host(state: &AppState, host_id: i64) -> Result<Arc<FwdHandle>, String> {
    let existing = tunnels()
        .lock()
        .expect("tunnels mutex")
        .get(&host_id)
        .map(|t| Arc::clone(&t.handle));
    if let Some(handle) = existing {
        if !handle.is_closed() {
            return Ok(handle);
        }
        stop_host(state, host_id).await;
    }

    let host = state
        .with_db(|conn| db::get_host(conn, host_id).ok().flatten())
        .ok_or_else(|| format!("host {host_id} not found"))?;
    let auth = ssh::build_auth(&host)?;

    let remote_targets = Arc::new(Mutex::new(HashMap::new()));
    let handler = FwdHandler {
        remote_targets: Arc::clone(&remote_targets),
    };
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
    let mut handle = match connected {
        Err(_) => return Err("connection timed out".into()),
        Ok(Err(e)) => return Err(e.to_string()),
        Ok(Ok(handle)) => handle,
    };
    if let Err(message) = ssh::authenticate(&mut handle, &host.username, auth).await {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
        return Err(message);
    }

    let handle = Arc::new(handle);
    tunnels().lock().expect("tunnels mutex").insert(
        host_id,
        Tunnel {
            handle: Arc::clone(&handle),
            active: HashMap::new(),
            remote_targets,
        },
    );
    spawn_watchdog(state.clone(), host_id, Arc::clone(&handle));
    Ok(handle)
}

/// Drops dead tunnels and closes their listeners (parity with conn.on('close')).
fn spawn_watchdog(state: AppState, host_id: i64, handle: Arc<FwdHandle>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if handle.is_closed() {
                stop_host(&state, host_id).await;
                return;
            }
        }
    });
}

/// Pumps bytes both ways between a TCP socket and an SSH channel.
pub(crate) async fn pipe_channel_socket(socket: TcpStream, channel: russh::Channel<russh::client::Msg>) {
    let (mut rd, wr) = channel.split();
    let (mut sock_rd, mut sock_wr) = socket.into_split();

    let reader = tokio::spawn(async move {
        loop {
            match rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if sock_wr.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        let _ = sock_wr.shutdown().await;
    });

    let writer = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match sock_rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if wr.data_bytes(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = wr.eof().await;
        let _ = wr.close().await;
    });

    let _ = reader.await;
    let _ = writer.await;
}

async fn start_local(
    state: &AppState,
    fwd: &PortForward,
    handle: Arc<FwdHandle>,
    kind: &str,
) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", fwd.local_port as u16))
        .await
        .map_err(|e| {
            state.add_audit(
                "forward.error",
                Some(fwd.host_id),
                &format!("listen {}: {e}", fwd.local_port),
            );
            e.to_string()
        })?;
    let remote_host = fwd.remote_host.clone();
    let remote_port = fwd.remote_port as u32;
    let local_port = fwd.local_port as u32;
    let is_socks = kind == "socks";
    let abort = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let handle = Arc::clone(&handle);
            let remote_host = remote_host.clone();
            tokio::spawn(async move {
                if is_socks {
                    handle_socks_conn(handle, socket, local_port).await;
                } else {
                    handle_local_conn(handle, socket, remote_host, remote_port, local_port).await;
                }
            });
        }
    })
    .abort_handle();

    {
        let mut tunnels = tunnels().lock().expect("tunnels mutex");
        if let Some(tunnel) = tunnels.get_mut(&fwd.host_id) {
            tunnel.active.insert(
                fwd.id,
                if is_socks { Active::Socks { abort } } else { Active::Local { abort } },
            );
        }
    }
    state.add_audit(
        "forward.start",
        Some(fwd.host_id),
        &format!(
            "{kind} :{} → {}:{}",
            fwd.local_port, fwd.remote_host, fwd.remote_port
        ),
    );
    Ok(())
}

async fn handle_local_conn(
    handle: Arc<FwdHandle>,
    mut socket: TcpStream,
    remote_host: String,
    remote_port: u32,
    local_port: u32,
) {
    match handle
        .channel_open_direct_tcpip(&remote_host, remote_port, "127.0.0.1", local_port)
        .await
    {
        Ok(channel) => pipe_channel_socket(socket, channel).await,
        Err(_) => {
            let _ = socket.shutdown().await;
        }
    }
}

async fn handle_socks_conn(handle: Arc<FwdHandle>, socket: TcpStream, local_port: u32) {
    let (mut rd, mut wr) = socket.into_split();
    let mut buf: Vec<u8> = Vec::new();

    // Greeting: VER NMETHODS METHODS...
    while buf.len() < 2 {
        match read_more(&mut rd, &mut buf).await {
            true => continue,
            false => return,
        }
    }
    if buf[0] != 0x05 {
        return;
    }
    let nmethods = buf[1] as usize;
    while buf.len() < 2 + nmethods {
        if !read_more(&mut rd, &mut buf).await {
            return;
        }
    }
    if wr.write_all(&[0x05, 0x00]).await.is_err() {
        return;
    }
    buf.drain(..2 + nmethods);

    // Request: VER CMD RSV ATYP ADDR PORT
    while buf.len() < 4 {
        if !read_more(&mut rd, &mut buf).await {
            return;
        }
    }
    if buf[0] != 0x05 {
        return;
    }
    let cmd = buf[1];
    let atyp = buf[3];
    let addr_len = match atyp {
        0x01 => 4,
        0x03 => {
            while buf.len() < 5 {
                if !read_more(&mut rd, &mut buf).await {
                    return;
                }
            }
            1 + buf[4] as usize
        }
        0x04 => 16,
        _ => {
            let _ = wr.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            let _ = wr.shutdown().await;
            return;
        }
    };
    while buf.len() < 4 + addr_len + 2 {
        if !read_more(&mut rd, &mut buf).await {
            return;
        }
    }
    let port = u16::from_be_bytes([buf[4 + addr_len], buf[5 + addr_len]]);
    let host: String = match atyp {
        0x01 => format!("{}.{}.{}.{}", buf[4], buf[5], buf[6], buf[7]),
        0x03 => String::from_utf8_lossy(&buf[5..5 + addr_len - 1]).into_owned(),
        _ => buf[4..4 + addr_len].iter().map(|b| format!("{b:02x}")).collect(),
    };
    buf.drain(..6 + addr_len);

    if cmd != 0x01 {
        let _ = wr.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        let _ = wr.shutdown().await;
        return;
    }

    match handle
        .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", local_port)
        .await
    {
        Ok(channel) => {
            if wr.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.is_err() {
                return;
            }
            // Leftover buffered payload flows into the tunnel.
            if !buf.is_empty() {
                let (ch_rd, ch_wr) = channel.split();
                if ch_wr.data_bytes(Bytes::from(buf)).await.is_err() {
                    return;
                }
                pipe_rest(rd, wr, ch_rd, ch_wr).await;
            } else {
                pipe_channel_socket_half(rd, wr, channel).await;
            }
        }
        Err(_) => {
            let _ = wr.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            let _ = wr.shutdown().await;
        }
    }
}

async fn read_more(rd: &mut tokio::net::tcp::OwnedReadHalf, buf: &mut Vec<u8>) -> bool {
    let mut tmp = [0u8; 4096];
    match rd.read(&mut tmp).await {
        Ok(0) | Err(_) => false,
        Ok(n) => {
            buf.extend_from_slice(&tmp[..n]);
            true
        }
    }
}

async fn pipe_channel_socket_half(
    mut sock_rd: tokio::net::tcp::OwnedReadHalf,
    mut sock_wr: tokio::net::tcp::OwnedWriteHalf,
    channel: russh::Channel<russh::client::Msg>,
) {
    // Reassemble the halves into a stream-free pump.
    let (mut ch_rd, ch_wr) = channel.split();
    let reader = tokio::spawn(async move {
        loop {
            match ch_rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if sock_wr.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        let _ = sock_wr.shutdown().await;
    });
    let writer = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match sock_rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ch_wr.data_bytes(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ch_wr.eof().await;
        let _ = ch_wr.close().await;
    });
    let _ = reader.await;
    let _ = writer.await;
}

async fn pipe_rest(
    mut sock_rd: tokio::net::tcp::OwnedReadHalf,
    mut sock_wr: tokio::net::tcp::OwnedWriteHalf,
    mut ch_rd: russh::ChannelReadHalf,
    ch_wr: russh::ChannelWriteHalf<russh::client::Msg>,
) {
    let reader = tokio::spawn(async move {
        loop {
            match ch_rd.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if sock_wr.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        let _ = sock_wr.shutdown().await;
    });
    let writer = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match sock_rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ch_wr.data_bytes(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ch_wr.eof().await;
        let _ = ch_wr.close().await;
    });
    let _ = reader.await;
    let _ = writer.await;
}

async fn start_remote(state: &AppState, fwd: &PortForward, handle: Arc<FwdHandle>) -> Result<(), String> {
    let bind_port = handle
        .tcpip_forward("127.0.0.1", fwd.local_port as u32)
        .await
        .map_err(|e| e.to_string())?;
    let real_port = if bind_port == 0 {
        fwd.local_port as u16
    } else {
        bind_port as u16
    };
    {
        let mut tunnels = tunnels().lock().expect("tunnels mutex");
        if let Some(tunnel) = tunnels.get_mut(&fwd.host_id) {
            tunnel
                .remote_targets
                .lock()
                .expect("remote targets mutex")
                .insert(real_port, (fwd.remote_host.clone(), fwd.remote_port as u32));
            tunnel.active.insert(fwd.id, Active::Remote { bind_port: real_port });
        }
    }
    state.add_audit(
        "forward.start",
        Some(fwd.host_id),
        &format!(
            "remote :{real_port} → {}:{}",
            fwd.remote_host, fwd.remote_port
        ),
    );
    Ok(())
}

pub async fn start_forward(state: &AppState, id: i64) -> Result<(), String> {
    let Some(fwd) = find_forward(state, id) else {
        return Err(format!("forward {id} not found"));
    };
    let handle = connect_host(state, fwd.host_id).await?;
    {
        let tunnels = tunnels().lock().expect("tunnels mutex");
        if tunnels
            .get(&fwd.host_id)
            .map(|t| t.active.contains_key(&fwd.id))
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    match fwd.protocol.as_str() {
        "remote" => start_remote(state, &fwd, handle).await,
        "socks" => start_local(state, &fwd, handle, "socks").await,
        _ => start_local(state, &fwd, handle, "local").await,
    }
}

pub async fn stop_forward(state: &AppState, id: i64) -> Result<(), String> {
    let Some(fwd) = find_forward(state, id) else {
        return Ok(());
    };
    let active = {
        let mut tunnels = tunnels().lock().expect("tunnels mutex");
        tunnels
            .get_mut(&fwd.host_id)
            .and_then(|t| t.active.remove(&id))
    };
    match active {
        Some(Active::Remote { bind_port }) => {
            let handle = tunnels()
                .lock()
                .expect("tunnels mutex")
                .get(&fwd.host_id)
                .map(|t| Arc::clone(&t.handle));
            if let Some(handle) = handle {
                let _ = handle
                    .cancel_tcpip_forward("127.0.0.1", bind_port as u32)
                    .await;
            }
            if let Some(tunnel) = tunnels().lock().expect("tunnels mutex").get(&fwd.host_id) {
                tunnel
                    .remote_targets
                    .lock()
                    .expect("remote targets mutex")
                    .remove(&bind_port);
            }
        }
        Some(Active::Local { abort }) | Some(Active::Socks { abort }) => {
            abort.abort();
        }
        None => {}
    }
    state.add_audit("forward.stop", Some(fwd.host_id), &format!(":{}", fwd.local_port));
    Ok(())
}

pub async fn stop_host(state: &AppState, host_id: i64) {
    let ids: Vec<i64> = {
        let tunnels = tunnels().lock().expect("tunnels mutex");
        tunnels
            .get(&host_id)
            .map(|t| t.active.keys().copied().collect())
            .unwrap_or_default()
    };
    for id in ids {
        let _ = stop_forward(state, id).await;
    }
    let tunnel = tunnels().lock().expect("tunnels mutex").remove(&host_id);
    if let Some(tunnel) = tunnel {
        let _ = tunnel
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
    }
}

pub fn forward_states(state: &AppState) -> Value {
    let mut out = Map::new();
    let forwards = state
        .with_db(|conn| db::list_forwards(conn, None).ok())
        .unwrap_or_default();
    for fwd in &forwards {
        out.insert(
            fwd.id.to_string(),
            json!({ "active": false }),
        );
    }
    let tunnels = tunnels().lock().expect("tunnels mutex");
    for tunnel in tunnels.values() {
        for (id, active) in &tunnel.active {
            let mut entry = Map::new();
            entry.insert("active".into(), json!(true));
            match active {
                Active::Local { .. } => {
                    entry.insert("kind".into(), json!("local"));
                }
                Active::Socks { .. } => {
                    entry.insert("kind".into(), json!("socks"));
                }
                Active::Remote { bind_port } => {
                    entry.insert("kind".into(), json!("remote"));
                    entry.insert("realPort".into(), json!(bind_port));
                }
            }
            out.insert(id.to_string(), Value::Object(entry));
        }
    }
    Value::Object(out)
}

pub async fn start_auto_forwards(state: &AppState, host_id: i64) {
    let forwards = state
        .with_db(|conn| db::list_forwards(conn, Some(host_id)).ok())
        .unwrap_or_default();
    for fwd in forwards {
        if !fwd.auto_start {
            continue;
        }
        if let Err(e) = start_forward(state, fwd.id).await {
            state.add_audit(
                "forward.error",
                Some(host_id),
                &format!("auto-start :{}: {e}", fwd.local_port),
            );
        }
    }
}
