use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::state::AppState;
use crate::{db, tokens};

/// Origins allowed to open authenticated WebSockets. The Tauri webview is
/// cross-origin from the loopback API by design; the old TS server's strict
/// same-origin check would reject it.
const DESKTOP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

pub async fn auth_middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let is_api = path.starts_with("/api/");
    let is_ws = path.starts_with("/ws/");
    if !is_api && !is_ws {
        return next.run(req).await;
    }

    let authorized = state.with_db(db::has_active_token);
    if !authorized {
        return next.run(req).await;
    }

    if is_ws {
        if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let host = req
                .headers()
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            let same_origin = origin == format!("http://{host}") || origin == format!("https://{host}");
            if !same_origin && !DESKTOP_ORIGINS.contains(&origin) {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "forbidden: cross-origin websocket" })),
                )
                    .into_response();
            }
        }
    }

    let token = present_token(&req);
    let Some(token) = token else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized: missing bearer token" })),
        )
            .into_response();
    };
    let verified = state.with_db(|conn| db::verify_token(conn, &token).ok().flatten());
    if verified.is_none() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized: unknown or revoked token" })),
        )
            .into_response();
    }
    next.run(req).await
}

fn present_token(req: &Request) -> Option<String> {
    if let Some(value) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let (scheme, rest) = value.split_once(' ')?;
        if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
            return Some(rest.trim().to_string());
        }
    }
    req.uri().query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == "token" && !v.is_empty()).then(|| {
                urldecode(v)
            })
        })
    })
}

fn urldecode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &value[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Bearer-only check with a scope requirement (parity with TS `requireScope`).
pub fn verify_scope(state: &AppState, authorization: Option<&str>, required: &str) -> Result<crate::models::AppPassword, (StatusCode, String)> {
    let Some(header_value) = authorization else {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized: missing bearer token".into()));
    };
    let Some(token) = header_value.strip_prefix("Bearer ").map(str::trim) else {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized: missing bearer token".into()));
    };
    let record = state
        .with_db(|conn| db::verify_token(conn, token).ok().flatten())
        .ok_or((StatusCode::UNAUTHORIZED, "unauthorized: unknown or revoked token".into()))?;
    if !tokens::scope_satisfied(&record.scope, required) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("forbidden: requires scope '{required}'"),
        ));
    }
    Ok(record)
}
