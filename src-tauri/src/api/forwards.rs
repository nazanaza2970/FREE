use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{db_fail, err, ApiError};
use crate::db;
use crate::models::{PortForward, PortForwardInput};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/status", get(status))
        .route("/{id}/start", post(start))
        .route("/{id}/stop", post(stop))
        .route("/{id}", delete(remove))
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(rename = "hostId")]
    host_id: Option<i64>,
}

async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<PortForward>>, ApiError> {
    Ok(Json(
        state.with_db(|conn| db::list_forwards(conn, query.host_id)).map_err(db_fail)?,
    ))
}

async fn create(
    State(state): State<AppState>,
    Json(body): Json<PortForwardInput>,
) -> Result<(StatusCode, Json<PortForward>), ApiError> {
    if body.local_port == 0 || body.remote_port == 0 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "host_id, local_port and remote_port are required",
        ));
    }
    let created = state
        .with_db(|conn| db::create_forward(conn, &body))
        .map_err(db_fail)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    Json(crate::forwards::forward_states(&state))
}

async fn start(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    crate::forwards::start_forward(&state, id)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "id": id, "active": true })))
}

async fn stop(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    crate::forwards::stop_forward(&state, id)
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "id": id, "active": false })))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let _ = crate::forwards::stop_forward(&state, id).await;
    state.with_db(|conn| db::delete_forward(conn, id)).map_err(db_fail)?;
    Ok(StatusCode::NO_CONTENT)
}
