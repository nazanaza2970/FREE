use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::models::{Host, HostInput};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route(
            "/{id}",
            get(get_one).put(update).delete(remove),
        )
}

fn reveal_vnc_password(state: &AppState, mut host: Host) -> Host {
    if let Some(blob) = host.vnc_password.clone() {
        host.vnc_password = state.keystore.decrypt(&blob).ok();
    }
    host
}

fn validate_numeric(input: &HostInput) -> Option<String> {
    let checks: [(&str, Option<i64>, i64, i64); 4] = [
        ("port", input.port, 1, 65535),
        ("vnc_port", input.vnc_port.flatten(), 1, 65535),
        ("vnc_ssh_host_id", input.vnc_ssh_host_id.flatten(), 1, i64::MAX),
        ("vnc_display", input.vnc_display.flatten(), 0, 99),
    ];
    for (field, value, min, max) in checks {
        if let Some(n) = value {
            if n < min || n > max {
                return Some(format!("{field} must be an integer between {min} and {max}"));
            }
        }
    }
    None
}

fn encrypt_input(state: &AppState, input: &mut HostInput) {
    let Some(value) = input.vnc_password.take() else {
        return;
    };
    input.vnc_password = Some(match value {
        None => None,
        Some(plain) if plain.is_empty() => None,
        Some(plain) => Some(state.keystore.encrypt(&plain)),
    });
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<Host>>, ApiError> {
    let hosts = state.with_db(db::list_hosts).map_err(db_fail)?;
    Ok(Json(
        hosts.into_iter().map(|h| reveal_vnc_password(&state, h)).collect(),
    ))
}

async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Host>, ApiError> {
    let host = state
        .with_db(|conn| db::get_host(conn, id))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "host not found"))?;
    Ok(Json(reveal_vnc_password(&state, host)))
}

async fn create(
    State(state): State<AppState>,
    Json(mut body): Json<HostInput>,
) -> Result<(StatusCode, Json<Host>), ApiError> {
    if body.name.as_deref().unwrap_or_default().is_empty()
        || body.host.as_deref().unwrap_or_default().is_empty()
    {
        return Err(err(StatusCode::BAD_REQUEST, "name and host are required"));
    }
    if let Some(message) = validate_numeric(&body) {
        return Err(err(StatusCode::BAD_REQUEST, message));
    }
    encrypt_input(&state, &mut body);
    let host = state.with_db(|conn| db::create_host(conn, &body)).map_err(db_fail)?;
    Ok((StatusCode::CREATED, Json(reveal_vnc_password(&state, host))))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(mut body): Json<HostInput>,
) -> Result<Json<Host>, ApiError> {
    if let Some(message) = validate_numeric(&body) {
        return Err(err(StatusCode::BAD_REQUEST, message));
    }
    encrypt_input(&state, &mut body);
    let host = state
        .with_db(|conn| db::update_host(conn, id, &body))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "host not found"))?;
    Ok(Json(reveal_vnc_password(&state, host)))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let host = state.with_db(|conn| db::get_host(conn, id)).map_err(db_fail)?;
    if host.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "host not found"));
    }
    state.with_db(|conn| db::delete_host(conn, id)).map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
