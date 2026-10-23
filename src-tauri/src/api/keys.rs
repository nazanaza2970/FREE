use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{err, ApiError};
use crate::ssh;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/generate", post(generate))
}

#[derive(Deserialize)]
struct GenerateBody {
    #[serde(rename = "type")]
    key_type: Option<String>,
    #[allow(dead_code)]
    bits: Option<u32>,
    comment: Option<String>,
}

async fn generate(
    State(_state): State<AppState>,
    Json(body): Json<GenerateBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key_type = match body.key_type.as_deref() {
        Some("rsa") => "rsa",
        Some("ed25519") | None => "ed25519",
        Some(other) => {
            return Err(err(
                axum::http::StatusCode::BAD_REQUEST,
                format!("unsupported key type: {other}"),
            ));
        }
    };
    match ssh::generate_keypair(key_type, body.bits.unwrap_or(3072), body.comment.as_deref()) {
        Ok(generated) => Ok(Json(json!({
            "type": generated.key_type,
            "private": generated.private,
            "public": generated.public,
            "fingerprint": generated.fingerprint,
        }))),
        // Bits are accepted for parity but RSA keys are always 4096-bit
        // (ssh-key does not expose the size).
        Err(message) => Err(err(axum::http::StatusCode::BAD_REQUEST, message)),
    }
}
