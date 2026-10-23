use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{db_fail, err, ApiError};
use crate::auth::verify_scope;
use crate::db;
use crate::models::{AppPassword, AppPasswordCreated};
use crate::state::AppState;
use crate::tokens;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/verify", get(verify))
        .route("/{id}", delete(remove))
}

#[derive(Deserialize)]
struct CreateTokenBody {
    name: Option<String>,
    scope: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateTokenBody>,
) -> Result<(StatusCode, Json<AppPasswordCreated>), ApiError> {
    let name = body.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name is required"));
    }
    let scope = body
        .scope
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "read".into());
    let (token, hash) = tokens::generate_token();
    let password = state
        .with_db(|conn| db::create_app_password(conn, &name, &scope, &hash))
        .map_err(db_fail)?;
    state.add_audit("token.create", None, &format!("{name} (scope: {scope})"));
    Ok((
        StatusCode::CREATED,
        Json(AppPasswordCreated { password, token }),
    ))
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<AppPassword>>, ApiError> {
    Ok(Json(state.with_db(db::list_app_passwords).map_err(db_fail)?))
}

async fn verify(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let record = verify_scope(&state, auth, "verify")
        .map_err(|(status, message)| (status, Json(json!({ "error": message }))))?;
    Ok(Json(json!({
        "id": record.id,
        "name": record.name,
        "scope": record.scope,
    })))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let existing = state
        .with_db(db::list_app_passwords)
        .map_err(db_fail)?
        .into_iter()
        .find(|p| p.id == id);
    if existing.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "token not found"));
    }
    state.with_db(|conn| db::revoke_app_password(conn, id)).map_err(db_fail)?;
    if let Some(existing) = existing {
        state.add_audit("token.revoke", None, &existing.name);
    }
    Ok(StatusCode::NO_CONTENT)
}
