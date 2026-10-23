mod audit;
mod forwards;
mod groups;
mod hosts;
mod keys;
mod known_hosts;
mod settings;
mod snippets;
mod sync;
mod themes;
mod tokens;
mod vnc;
mod ws_sftp;
mod ws_terminal;
mod ws_vnc;

use std::convert::Infallible;
use std::sync::OnceLock;
use std::time::Instant;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{middleware, Json, Router};
use futures_util::StreamExt;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use crate::auth::auth_middleware;
use crate::state::AppState;

pub type ApiError = (axum::http::StatusCode, Json<serde_json::Value>);

pub fn err(status: axum::http::StatusCode, message: impl Into<String>) -> ApiError {
    (status, Json(json!({ "error": message.into() })))
}

pub fn db_fail(e: impl std::fmt::Display) -> ApiError {
    err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .nest("/hosts", hosts::routes())
        .nest("/groups", groups::routes())
        .nest("/snippets", snippets::routes())
        .nest("/themes", themes::routes())
        .nest("/audit", audit::routes())
        .nest("/settings", settings::routes())
        .nest("/forwards", forwards::routes())
        .nest("/known-hosts", known_hosts::routes())
        .nest("/tokens", tokens::routes())
        .nest("/keys", keys::routes())
        .nest("/sync", sync::routes())
        .nest("/vnc", vnc::routes());

    Router::new()
        .route("/health", get(health))
        .route("/ws/terminal", get(ws_terminal::ws_upgrade))
        .route("/ws/sftp", get(ws_sftp::ws_upgrade))
        .route("/ws/vnc", get(ws_vnc::ws_upgrade))
        .nest("/api", api)
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .with_state(state)
}

async fn health(State(_state): State<AppState>) -> Json<serde_json::Value> {
    static START: OnceLock<Instant> = OnceLock::new();
    Json(json!({
        "status": "ok",
        "uptime": START.get_or_init(Instant::now).elapsed().as_secs_f64(),
        "timestamp": chrono_lite_now(),
    }))
}

/// Audit live stream: recent backlog, then broadcast events (parity with the
/// old SSE endpoint).
pub(crate) async fn audit_stream(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let mut records = state.with_db(|conn| crate::db::list_audit(conn, 100)).unwrap_or_default();
    records.reverse();
    let backlog = futures_util::stream::iter(records.into_iter().map(|record| {
        Ok(Event::default().data(serde_json::to_string(&record).unwrap_or_default()))
    }));
    let live = BroadcastStream::new(state.audit_tx.subscribe()).map(|record| {
        Ok(match record {
            Ok(rec) => Event::default().data(serde_json::to_string(&rec).unwrap_or_default()),
            Err(_) => Event::default(),
        })
    });
    Sse::new(backlog.chain(live)).keep_alive(KeepAlive::default())
}

fn chrono_lite_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-from-civil inverse (UTC).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
