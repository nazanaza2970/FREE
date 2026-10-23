use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

use super::{err, ApiError};
use crate::db;
use crate::models::Host;
use crate::state::AppState;
use crate::vnc;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/{id}/status", get(status))
        .route("/{id}/diagnose", post(diagnose))
        .route("/{id}/ensure", post(ensure))
        .route("/{id}/stop", post(stop))
}

async fn find_vnc_host(state: &AppState, id: i64) -> Result<Host, ApiError> {
    let host = state.with_db(|conn| db::get_host(conn, id)).map_err(super::db_fail)?;
    match host {
        Some(host) if host.connection_type == "vnc" => Ok(host),
        _ => Err(err(StatusCode::NOT_FOUND, "vnc host not found")),
    }
}

async fn status(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<vnc::VncStatus>, ApiError> {
    let host = find_vnc_host(&state, id).await?;
    Ok(Json(vnc::build_status(&state, &host).await))
}

async fn diagnose(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<vnc::VncDiagnostics>, ApiError> {
    let host = find_vnc_host(&state, id).await?;
    let cfg = vnc::resolve_vnc_config(&state, &host);
    if cfg.ssh.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "diagnostics require an SSH transport",
        ));
    }
    let mut diagnostics = match vnc::diagnose_vnc_environment(&state, &host).await {
        Some(diagnostics) => diagnostics,
        None => {
            return Err(err(StatusCode::BAD_GATEWAY, "diagnostics unavailable"));
        }
    };
    let implementation = vnc::resolve_implementation(Some(&diagnostics), &host);
    diagnostics.requirements = vnc::get_vnc_requirements(Some(&diagnostics), &implementation);
    Ok(Json(diagnostics))
}

async fn ensure(State(state): State<AppState>, Path(id): Path<i64>, body: Option<Json<EnsureBody>>) -> Result<Json<vnc::VncStatus>, ApiError> {
    let host = find_vnc_host(&state, id).await?;
    let start = body.map(|Json(b)| b.start).unwrap_or(false);
    vnc::ensure_session(&state, host.id, start)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(vnc::build_status(&state, &host).await))
}

async fn stop(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<vnc::VncStatus>, ApiError> {
    let host = find_vnc_host(&state, id).await?;
    vnc::stop_session(&state, id).await;
    Ok(Json(vnc::build_status(&state, &host).await))
}

#[derive(serde::Deserialize)]
struct EnsureBody {
    #[serde(default)]
    start: bool,
}
