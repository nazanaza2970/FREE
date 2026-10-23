use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};

use super::{db_fail, ApiError};
use crate::db;
use crate::models::KnownHost;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(list)).route("/{id}", delete(remove))
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<KnownHost>>, ApiError> {
    Ok(Json(state.with_db(db::list_known_hosts).map_err(db_fail)?))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.with_db(|conn| db::delete_known_host(conn, id)).map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
