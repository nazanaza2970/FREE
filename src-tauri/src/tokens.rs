use std::fs;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::db;

pub const TOKEN_PREFIX: &str = "tfp_";

/// SHA-256 (hex) of a plaintext token. Only the hash is persisted.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Generates a fresh opaque token and its storage hash.
pub fn generate_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    let hash = hash_token(&token);
    (token, hash)
}

/// A token satisfies a required scope when it matches, or is the wildcard `*`.
pub fn scope_satisfied(token_scope: &str, required: &str) -> bool {
    token_scope == "*" || token_scope == required
}

/// First desktop run: mint a wildcard token so the webview can authenticate
/// immediately. Returns the plaintext (once) or None when tokens already exist.
pub fn ensure_bootstrap_token(conn: &Connection) -> Option<String> {
    if db::has_active_token(conn) {
        return None;
    }
    let (token, hash) = generate_token();
    db::create_app_password(conn, "desktop-bootstrap", "*", &hash).ok()?;
    Some(token)
}

/// Returns a stable desktop token whose plaintext is persisted next to the
/// keystore (`<config>/desktop-token`). Unlike [`ensure_bootstrap_token`], this
/// keeps working on later launches and even when the database already holds
/// tokens (e.g. a migrated legacy DB), so the webview can always unlock.
pub fn ensure_desktop_token(conn: &Connection, config_dir: &Path) -> Option<String> {
    let path = config_dir.join("desktop-token");
    if let Ok(raw) = fs::read_to_string(&path) {
        let token = raw.trim().to_string();
        if !token.is_empty()
            && db::verify_token(conn, &token)
                .ok()
                .flatten()
                .is_some()
        {
            return Some(token);
        }
    }
    let (token, hash) = generate_token();
    db::create_app_password(conn, "desktop", "*", &hash).ok()?;
    let _ = fs::create_dir_all(config_dir);
    let _ = fs::write(&path, format!("{token}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_sha256_hex() {
        // SHA-256("abc")
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_token("a").len(), 64);
        assert_ne!(hash_token("a"), hash_token("b"));
    }

    #[test]
    fn token_format() {
        let (token, hash) = generate_token();
        assert!(token.starts_with(TOKEN_PREFIX));
        assert!(token.len() > 40);
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn scope_wildcard() {
        assert!(scope_satisfied("*", "verify"));
        assert!(scope_satisfied("verify", "verify"));
        assert!(!scope_satisfied("read", "verify"));
    }
}
