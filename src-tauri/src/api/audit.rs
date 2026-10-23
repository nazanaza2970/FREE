use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use super::{audit_stream, db_fail, ApiError};
use crate::db;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/stream", get(audit_stream))
        .route("/export", get(export))
}

#[derive(Deserialize)]
struct AuditQuery {
    limit: Option<i64>,
}

fn parse_limit(raw: Option<i64>, fallback: i64, max: i64) -> i64 {
    let n = raw.unwrap_or(fallback);
    n.clamp(1, max)
}

async fn list(
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<crate::models::AuditLog>>, ApiError> {
    let limit = parse_limit(query.limit, 200, 1000);
    Ok(Json(state.with_db(|conn| db::list_audit(conn, limit)).map_err(db_fail)?))
}

async fn export(
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = parse_limit(query.limit, 1000, 5000);
    let rows = state.with_db(|conn| db::list_audit(conn, limit)).map_err(db_fail)?;
    let mut body = String::new();
    for row in &rows {
        body.push_str(&serde_json::to_string(row).unwrap_or_default());
        body.push('\n');
    }
    Ok((
        StatusCode::OK,
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/x-ndjson; charset=utf-8",
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"free-audit.log\"",
            ),
        ],
        body,
    ))
}
