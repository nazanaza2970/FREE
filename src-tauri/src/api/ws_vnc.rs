//! `/ws/vnc` — binary RFB tunnel (parity with `server/vnc/websocket.ts`).
//!
//! The client sends a `host_id` query parameter. Binary WebSocket payloads are
//! piped to/from the VNC stream (raw TCP for `direct`, SSH direct-tcpip for
//! `ssh`). Text frames are forwarded as UTF-8 bytes.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::db;
use crate::state::AppState;
use crate::vnc;

#[derive(Debug, Deserialize)]
pub struct VncQuery {
    host_id: Option<i64>,
}

pub async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<VncQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(state, query.host_id.unwrap_or(0), socket))
}

async fn handle_socket(state: AppState, host_id: i64, socket: WebSocket) {
    let host = match state.with_db(|conn| db::get_host(conn, host_id).ok().flatten()) {
        Some(host) if host.connection_type == "vnc" => host,
        _ => return close(socket).await,
    };

    let ensure = match vnc::ensure_session(&state, host_id, false).await {
        Ok(result) => result,
        Err(_) => return close(socket).await,
    };
    let Some(session) = ensure.session else {
        return close(socket).await;
    };
    vnc::enter_session(host_id).await;
    let auto_stop = host.vnc_auto_stop;

    let mut stream = match vnc::open_vnc_stream(&state, &host, Some(session.port)).await {
        Ok(stream) => stream,
        Err(_) => {
            leave_and_maybe_stop(&state, host_id, auto_stop).await;
            return close(socket).await;
        }
    };

    state.add_audit("vnc.connect", Some(host.id), &format!("port {}", session.port));

    let (mut sink, mut ws_in) = socket.split();

    // Single owner of the VNC stream: fan-in from the WS and fan-out to it.
    loop {
        tokio::select! {
            incoming = ws_in.next() => {
                match incoming {
                    Some(Ok(Message::Binary(data))) => {
                        if stream.write(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if stream.write(text.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                }
            }
            data = stream.read_chunk() => {
                match data {
                    Ok(Some(chunk)) if !chunk.is_empty() => {
                        if sink.send(Message::Binary(chunk.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }

    let _ = stream.close().await;
    let _ = sink.close().await;
    leave_and_maybe_stop(&state, host_id, auto_stop).await;
}

async fn leave_and_maybe_stop(state: &AppState, host_id: i64, auto_stop: bool) {
    if vnc::leave_session(host_id).await && auto_stop {
        vnc::stop_session(state, host_id).await;
    }
}

async fn close(socket: WebSocket) {
    let mut socket = socket;
    let _ = socket.close().await;
}
