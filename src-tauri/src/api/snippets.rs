use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{db_fail, err, ApiError};
use crate::db::{self, GroupFilter};
use crate::models::{Snippet, SnippetInput};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route(
            "/{id}",
            get(get_one).put(update).delete(remove),
        )
        .route("/{id}/reveal", get(reveal))
}

fn mask(snippet: &mut Snippet) {
    if snippet.protected_ {
        snippet.content = String::new();
    }
}

#[derive(Deserialize)]
struct ListQuery {
    group_id: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Snippet>>, ApiError> {
    let filter = match query.group_id.as_deref() {
        None => GroupFilter::All,
        Some("global") => GroupFilter::Global,
        Some(raw) => {
            let id: i64 = raw.parse().unwrap_or(0);
            GroupFilter::Id(id)
        }
    };
    let mut items = state
        .with_db(|conn| db::list_snippets(conn, filter))
        .map_err(db_fail)?;
    for item in &mut items {
        mask(item);
    }
    Ok(Json(items))
}

async fn create(
    State(state): State<AppState>,
    Json(mut body): Json<SnippetInput>,
) -> Result<(StatusCode, Json<Snippet>), ApiError> {
    if body.name.as_deref().unwrap_or_default().is_empty()
        || body.content.as_deref().unwrap_or_default().is_empty()
    {
        return Err(err(StatusCode::BAD_REQUEST, "name and content are required"));
    }
    let protected_flag = body.protected_.unwrap_or(false);
    if protected_flag {
        let plain = body.content.take().unwrap_or_default();
        body.content = Some(state.keystore.encrypt(&plain));
    }
    let name = body.name.clone().unwrap_or_default();
    let created = state
        .with_db(|conn| db::create_snippet(conn, &body))
        .map_err(db_fail)?;
    let detail = if protected_flag {
        format!("{name} (protected)")
    } else {
        name
    };
    state.add_audit("snippet.create", None, &detail);
    let mut created = created;
    mask(&mut created);
    Ok((StatusCode::CREATED, Json(created)))
}

async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Snippet>, ApiError> {
    let mut snippet = state
        .with_db(|conn| db::get_snippet(conn, id))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "snippet not found"))?;
    mask(&mut snippet);
    Ok(Json(snippet))
}

async fn reveal(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let snippet = state
        .with_db(|conn| db::get_snippet(conn, id))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "snippet not found"))?;
    let content = if snippet.protected_ {
        state
            .keystore
            .decrypt(&snippet.content)
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("decrypt failed: {e}")))?
    } else {
        snippet.content.clone()
    };
    state.add_audit("snippet.reveal", None, &snippet.name);
    Ok(Json(json!({
        "id": snippet.id,
        "name": snippet.name,
        "content": content,
    })))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(mut body): Json<SnippetInput>,
) -> Result<Json<Snippet>, ApiError> {
    let existing = state
        .with_db(|conn| db::get_snippet(conn, id))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "snippet not found"))?;
    let will_protect = body.protected_.unwrap_or(existing.protected_);
    if let Some(content) = body.content.take() {
        body.content = Some(if will_protect {
            state.keystore.encrypt(&content)
        } else {
            content
        });
    }
    body.protected_ = Some(will_protect);
    let updated = state
        .with_db(|conn| db::update_snippet(conn, id, &body))
        .map_err(db_fail)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "snippet not found"))?;
    state.add_audit("snippet.update", None, &updated.name);
    let mut updated = updated;
    mask(&mut updated);
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let existing = state.with_db(|conn| db::get_snippet(conn, id)).map_err(db_fail)?;
    state.with_db(|conn| db::delete_snippet(conn, id)).map_err(db_fail)?;
    if let Some(existing) = existing {
        state.add_audit("snippet.delete", None, &existing.name);
    }
    Ok(StatusCode::NO_CONTENT)
}
