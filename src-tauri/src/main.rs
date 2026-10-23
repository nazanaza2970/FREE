#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use free::api;
use free::crypto;
use free::db;
use free::state::AppState;
use free::tokens;
use tauri::Manager;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("recover") => {
            if let Err(e) = run_recover() {
                eprintln!("recover failed: {e}");
                std::process::exit(1);
            }
        }
        Some("serve") => {
            init_tracing();
            if let Err(e) = run_serve() {
                eprintln!("serve failed: {e}");
                std::process::exit(1);
            }
        }
        _ => run_app(),
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
}

fn run_app() {
    init_tracing();

    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&config_dir)?;

            let db_path = std::env::var("TERMUS_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| data_dir.join("termius.db"));
            maybe_migrate_legacy_db(&db_path);

            let (rt, listener, base_url) = open_api(0)?;
            let state = build_core_state(&db_path, &config_dir, base_url.clone())?;
            let router = api::router(state.clone());
            std::thread::Builder::new()
                .name("api-server".into())
                .spawn(move || {
                    rt.block_on(async move {
                        tracing::info!("api listening on {base_url}");
                        if let Err(e) = axum::serve(listener, router).await {
                            tracing::error!("api server error: {e}");
                        }
                    })
                })?;

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_info])
        .run(tauri::generate_context!())
        .expect("error while running FREE");
}

/// Headless API server (`free serve`) — used by CI/smoke tests and available
/// as a power-user escape hatch. PORT env selects the port (0 = ephemeral).
fn run_serve() -> Result<(), String> {
    let data_dir = dirs_data_dir().join("dev.free.app");
    let config_dir = dirs_config_dir().join("dev.free.app");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

    let db_path = std::env::var("TERMUS_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("termius.db"));
    maybe_migrate_legacy_db(&db_path);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let (rt, listener, base_url) = open_api(port).map_err(|e| e.to_string())?;
    let state = build_core_state(&db_path, &config_dir, base_url.clone())
        .map_err(|e| e.to_string())?;
    println!("api listening on {base_url}");
    if let Some(token) = &state.bootstrap_token {
        println!("bootstrap token: {token}");
    }
    let router = api::router(state);
    rt.block_on(async move { axum::serve(listener, router).await })
        .map_err(|e| e.to_string())?;
    Ok(())
}

type ApiBoot = (
    tokio::runtime::Runtime,
    tokio::net::TcpListener,
    String,
);

fn open_api(port: u16) -> Result<ApiBoot, Box<dyn std::error::Error>> {
    let rt = tokio::runtime::Runtime::new()?;
    let listener = rt.block_on(tokio::net::TcpListener::bind(("127.0.0.1", port)))?;
    let base_url = format!("http://{}", listener.local_addr()?);
    Ok((rt, listener, base_url))
}

fn build_core_state(
    db_path: &Path,
    config_dir: &Path,
    api_base: String,
) -> Result<AppState, Box<dyn std::error::Error>> {
    let conn = db::init_db(db_path)?;
    let keystore = crypto::Keystore::load(config_dir)?;
    let (audit_tx, _) = tokio::sync::broadcast::channel(256);
    let bootstrap = tokens::ensure_bootstrap_token(&conn);
    Ok(AppState {
        db: Arc::new(Mutex::new(conn)),
        keystore: Arc::new(keystore),
        audit_tx,
        bootstrap_token: bootstrap,
        api_base,
        sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        recent_closes: Arc::new(Mutex::new(std::collections::HashMap::new())),
    })
}

#[derive(serde::Serialize)]
struct ApiInfo {
    base_url: String,
    token: Option<String>,
}

#[tauri::command]
fn get_api_info(state: tauri::State<'_, AppState>) -> ApiInfo {
    ApiInfo {
        base_url: state.api_base.clone(),
        token: state.bootstrap_token.clone(),
    }
}

/// First run on the desktop app: copy an old repo-local `data/termius.db` into
/// the app data dir so existing setups keep their hosts and keys.
fn maybe_migrate_legacy_db(target: &Path) {
    if target.exists() {
        return;
    }
    let candidates = [
        std::env::var("FREE_LEGACY_DB").ok().map(PathBuf::from),
        Some(PathBuf::from("data/termius.db")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            match std::fs::copy(&candidate, target) {
                Ok(n) => tracing::info!(
                    "migrated legacy database {} -> {} ({n} bytes)",
                    candidate.display(),
                    target.display()
                ),
                Err(e) => tracing::warn!("legacy db migration failed: {e}"),
            }
            return;
        }
    }
}

/// `free recover` — mints a fresh wildcard token when the lock screen shuts
/// the user out (replaces the old `scripts/insert-token.ts`).
fn run_recover() -> Result<(), String> {
    let data_dir = dirs_data_dir().join("dev.free.app");
    let db_path = std::env::var("TERMUS_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("termius.db"));
    if !db_path.exists() {
        return Err(format!("database not found at {}", db_path.display()));
    }
    let conn = db::init_db(&db_path).map_err(|e| e.to_string())?;
    let (token, hash) = tokens::generate_token();
    db::create_app_password(&conn, "recovery-cli", "*", &hash).map_err(|e| e.to_string())?;
    let _ = db::add_audit(&conn, "token.create", None, "recovery-cli (scope: *)");
    println!("{token}");
    Ok(())
}

fn dirs_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        PathBuf::from(base)
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support")
    }
}

fn dirs_config_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".config")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        PathBuf::from(base)
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support")
    }
}
