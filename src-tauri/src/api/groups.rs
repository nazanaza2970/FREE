use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::models::{GroupInput, HostGroup};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", put(update).delete(remove))
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<HostGroup>>, ApiError> {
    Ok(Json(state.with_db(db::list_groups).map_err(db_fail)?))
}

async fn create(
    State(state): State<AppState>,
    Json(body): Json<GroupInput>,
) -> Result<(StatusCode, Json<HostGroup>), ApiError> {
    if body.name.as_deref().unwrap_or_default().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name is required"));
    }
    let created = state
        .with_db(|conn| db::create_group(conn, &body))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "parent group not found"))?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<GroupInput>,
) -> Result<Json<HostGroup>, ApiError> {
    let exists = state
        .with_db(|conn| db::list_groups(conn).map(|groups| groups.iter().any(|g| g.id == id)))
        .map_err(db_fail)?;
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "group not found"));
    }
    let updated = state
        .with_db(|conn| db::update_group(conn, id, &body))
        .map_err(db_fail)?
        .ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "invalid parent (not found or would create a cycle)",
            )
        })?;
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.with_db(|conn| db::delete_group(conn, id)).map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
