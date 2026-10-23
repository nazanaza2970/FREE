use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::state::AppState;

const K_ENABLED: &str = "sync.enabled";
const K_SERVER_URL: &str = "sync.server_url";
const K_DEVICE_NAME: &str = "sync.device_name";
const K_DEVICE_ID: &str = "sync.device_id";
const K_TOKEN: &str = "sync.token";
const K_LAST_SYNC_AT: &str = "sync.last_sync_at";
const K_LAST_ERROR: &str = "sync.last_error";
const K_LAST_STATS: &str = "sync.last_stats";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/config", get(get_config).put(put_config))
        .route("/merge", post(merge))
}

fn random_device_id() -> String {
    let mut rng = rand::thread_rng();
    let a: u32 = rng.gen();
    let b: u32 = rng.gen();
    let c: u32 = rng.gen();
    let d: u32 = rng.gen();
    format!("{a:08x}-{b:04x}-4{c:03x}-a{d:03x}-{}", &format!("{a:08x}{b:08x}")[..12])
}

fn read_config(state: &AppState) -> Result<Value, ApiError> {
    let (device_id, enabled, server_url, device_name, token, last_sync_at, last_error, last_stats, pending) =
        state.with_db(|conn| {
            let get = |k: &str| db::get_setting(conn, k).map_err(db_fail);
            Ok::<_, ApiError>((
                get(K_DEVICE_ID)?,
                get(K_ENABLED)?,
                get(K_SERVER_URL)?,
                get(K_DEVICE_NAME)?,
                get(K_TOKEN)?,
                get(K_LAST_SYNC_AT)?,
                get(K_LAST_ERROR)?,
                get(K_LAST_STATS)?,
                conn.query_row("SELECT COUNT(*) FROM sync_queue", [], |r| r.get::<_, i64>(0))
                    .unwrap_or(0),
            ))
        })?;
    let device_id = match device_id {
        Some(id) => id,
        None => {
            let fresh = random_device_id();
            state
                .with_db(|conn| db::set_setting(conn, K_DEVICE_ID, &fresh))
                .map_err(db_fail)?;
            fresh
        }
    };
    let last_stats: Option<Value> = last_stats.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(json!({
        "enabled": enabled.as_deref() == Some("1"),
        "server_url": server_url.unwrap_or_default(),
        "device_name": device_name.unwrap_or_else(|| "device".into()),
        "device_id": device_id,
        "token": token.unwrap_or_default(),
        "last_sync_at": last_sync_at,
        "last_error": last_error,
        "last_stats": last_stats,
        "pending": pending,
    }))
}

#[derive(Deserialize, Default)]
pub struct SyncConfigInput {
    server_url: Option<String>,
    device_name: Option<String>,
    token: Option<String>,
    enabled: Option<bool>,
}

async fn get_config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(read_config(&state)?))
}

async fn put_config(
    State(state): State<AppState>,
    Json(body): Json<SyncConfigInput>,
) -> Result<Json<Value>, ApiError> {
    if let Some(url) = &body.server_url {
        let url = url.trim();
        if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(err(
                axum::http::StatusCode::BAD_REQUEST,
                "server_url must start with http:// or https://",
            ));
        }
        state
            .with_db(|conn| db::set_setting(conn, K_SERVER_URL, url))
            .map_err(db_fail)?;
    }
    if let Some(name) = &body.device_name {
        let name = name.trim();
        let name = if name.is_empty() { "device" } else { name };
        state
            .with_db(|conn| db::set_setting(conn, K_DEVICE_NAME, name))
            .map_err(db_fail)?;
    }
    if let Some(token) = &body.token {
        state
            .with_db(|conn| db::set_setting(conn, K_TOKEN, token.trim()))
            .map_err(db_fail)?;
    }
    if let Some(enabled) = body.enabled {
        state
            .with_db(|conn| db::set_setting(conn, K_ENABLED, if enabled { "1" } else { "0" }))
            .map_err(db_fail)?;
    }
    Ok(Json(read_config(&state)?))
}

async fn merge(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let cfg = read_config(&state)?;
    let device_id = cfg["device_id"].as_str().unwrap_or_default().to_string();
    if cfg["server_url"].as_str().unwrap_or_default().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "pushed": 0,
                "pulled": 0,
                "pending": cfg["pending"].as_i64().unwrap_or(0),
                "deviceId": device_id,
                "error": "sync server url not configured",
            })),
        ));
    }
    let error = "sync engine is not available in the desktop build yet";
    state
        .with_db(|conn| db::set_setting(conn, K_LAST_ERROR, error))
        .map_err(db_fail)?;
    state.add_audit("sync.merge", None, &format!("offline: {error}"));
    Ok(Json(json!({
        "ok": false,
        "pushed": 0,
        "pulled": 0,
        "pending": cfg["pending"].as_i64().unwrap_or(0),
        "deviceId": device_id,
        "error": error,
    })))
}
