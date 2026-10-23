use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/{key}", put(set).delete(remove))
}

async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let map = state.with_db(db::list_settings).map_err(db_fail)?;
    Ok(Json(Value::Object(map)))
}

#[derive(Deserialize)]
struct SettingBody {
    value: Option<String>,
}

async fn set(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<SettingBody>,
) -> Result<Json<Value>, ApiError> {
    let Some(value) = body.value else {
        return Err(err(StatusCode::BAD_REQUEST, "value is required"));
    };
    state
        .with_db(|conn| db::set_setting(conn, &key, &value))
        .map_err(db_fail)?;
    Ok(Json(json!({ "key": key, "value": value })))
}

async fn remove(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .with_db(|conn| conn.execute("DELETE FROM settings WHERE key = ?1", [&key]))
        .map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
