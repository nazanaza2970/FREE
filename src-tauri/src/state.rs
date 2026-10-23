use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::{broadcast, Notify};

use crate::crypto::Keystore;
use crate::db;
use crate::models::AuditLog;

/// Control handle for a live terminal session.
#[derive(Clone)]
pub struct SessionEntry {
    pub host_id: i64,
    pub shutdown: Arc<Notify>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub keystore: Arc<Keystore>,
    pub audit_tx: broadcast::Sender<AuditLog>,
    pub bootstrap_token: Option<String>,
    pub api_base: String,
    pub sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    pub recent_closes: Arc<Mutex<HashMap<i64, Instant>>>,
}

impl AppState {
    pub fn with_db<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
        let conn = self.db.lock().expect("db mutex poisoned");
        f(&conn)
    }

    /// Inserts an audit record and broadcasts it to `/api/audit/stream` listeners.
    pub fn add_audit(&self, action: &str, host_id: Option<i64>, detail: &str) {
        if let Some(record) = self
            .with_db(|conn| db::add_audit(conn, action, host_id, detail).ok())
        {
            let _ = self.audit_tx.send(record);
        }
    }
}
