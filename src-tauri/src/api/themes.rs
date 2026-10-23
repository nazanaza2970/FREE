use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::models::{Theme, ThemeInput};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", put(update).delete(remove))
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<Theme>>, ApiError> {
    Ok(Json(state.with_db(db::list_themes).map_err(db_fail)?))
}

async fn create(
    State(state): State<AppState>,
    Json(body): Json<ThemeInput>,
) -> Result<(StatusCode, Json<Theme>), ApiError> {
    if body.name.as_deref().unwrap_or_default().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name is required"));
    }
    let created = state.with_db(|conn| db::create_theme(conn, &body)).map_err(db_fail)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<ThemeInput>,
) -> Result<Json<Theme>, ApiError> {
    let updated = state
        .with_db(|conn| db::update_theme(conn, id, &body))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "theme not found"))?;
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.with_db(|conn| db::delete_theme(conn, id)).map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
