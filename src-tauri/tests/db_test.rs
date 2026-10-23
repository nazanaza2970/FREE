use std::path::PathBuf;

use free::db::{self, GroupFilter};
use free::models::*;
use free::tokens;

fn temp_db() -> (rusqlite::Connection, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "free-test-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.db");
    let conn = db::init_db(&path).unwrap();
    (conn, dir)
}

fn rand_suffix() -> u32 {
    use rand::Rng;
    rand::thread_rng().gen()
}

#[test]
fn host_crud_lifecycle() {
    let (conn, dir) = temp_db();
    let created = db::create_host(
        &conn,
        &HostInput {
            name: Some("web-1".into()),
            host: Some("10.0.0.5".into()),
            port: Some(2222),
            username: Some("deploy".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(created.id > 0);
    assert_eq!(created.name, "web-1");
    assert_eq!(created.port, 2222);

    let fetched = db::get_host(&conn, created.id).unwrap().unwrap();
    assert_eq!(fetched.host, "10.0.0.5");

    let updated = db::update_host(
        &conn,
        created.id,
        &HostInput {
            name: Some("web-1-renamed".into()),
            favorite: Some(true),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(updated.name, "web-1-renamed");
    assert!(updated.favorite);
    // untouched fields survive the partial update
    assert_eq!(updated.host, "10.0.0.5");
    assert_eq!(updated.port, 2222);

    assert_eq!(db::list_hosts(&conn).unwrap().len(), 1);
    db::delete_host(&conn, created.id).unwrap();
    assert!(db::list_hosts(&conn).unwrap().is_empty());
    assert!(db::get_host(&conn, created.id).unwrap().is_none());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn host_defaults_are_applied() {
    let (conn, dir) = temp_db();
    let h = db::create_host(
        &conn,
        &HostInput {
            name: Some("min".into()),
            host: Some("example.com".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(h.port, 22);
    assert_eq!(h.username, "root");
    assert_eq!(h.auth_method, "password");
    assert_eq!(h.keepalive, 30);
    assert!(!h.favorite);
    assert_eq!(h.connection_type, "ssh");
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn host_null_vs_absent_updates() {
    let (conn, dir) = temp_db();
    let h = db::create_host(
        &conn,
        &HostInput {
            name: Some("auth".into()),
            host: Some("h".into()),
            password: Some(Some("secret".into())),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(h.password.as_deref(), Some("secret"));

    // Absent password: unchanged.
    let kept = db::update_host(&conn, h.id, &HostInput::default()).unwrap().unwrap();
    assert_eq!(kept.password.as_deref(), Some("secret"));

    // Explicit null: cleared.
    let cleared = db::update_host(
        &conn,
        h.id,
        &HostInput {
            password: Some(None),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert!(cleared.password.is_none());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn vnc_fields_only_for_vnc_hosts() {
    let (conn, dir) = temp_db();
    let ssh_host = db::create_host(
        &conn,
        &HostInput {
            name: Some("s".into()),
            host: Some("h".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(ssh_host.vnc_port.is_none());
    assert!(ssh_host.vnc_transport.is_none());

    let vnc_host = db::create_host(
        &conn,
        &HostInput {
            name: Some("v".into()),
            host: Some("h".into()),
            connection_type: Some("vnc".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(vnc_host.vnc_port, Some(5900));
    assert_eq!(vnc_host.vnc_transport.as_deref(), Some("ssh"));
    assert!(vnc_host.vnc_auto_start);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn group_crud_and_host_grouping() {
    let (conn, dir) = temp_db();
    let group = db::create_group(
        &conn,
        &GroupInput {
            name: Some("Production".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert!(group.id > 0);
    let host = db::create_host(
        &conn,
        &HostInput {
            name: Some("api-1".into()),
            host: Some("10.1.1.1".into()),
            group_id: Some(Some(group.id)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(host.group_id, Some(group.id));
    assert_eq!(db::list_groups(&conn).unwrap().len(), 1);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn group_cycle_rejected() {
    let (conn, dir) = temp_db();
    let a = db::create_group(&conn, &GroupInput { name: Some("a".into()), ..Default::default() })
        .unwrap()
        .unwrap();
    let b = db::create_group(
        &conn,
        &GroupInput {
            name: Some("b".into()),
            parent_id: Some(Some(a.id)),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    // a -> b would create a cycle
    let result = db::update_group(
        &conn,
        a.id,
        &GroupInput {
            parent_id: Some(Some(b.id)),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result.is_none());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn snippet_crud_and_filters() {
    let (conn, dir) = temp_db();
    let s = db::create_snippet(
        &conn,
        &SnippetInput {
            name: Some("restart".into()),
            content: Some("systemctl restart nginx".into()),
            tags: Some("ops".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(s.id > 0);
    assert_eq!(s.tags, "ops");
    assert_eq!(db::list_snippets(&conn, GroupFilter::All).unwrap().len(), 1);

    let g = db::create_group(&conn, &GroupInput { name: Some("g".into()), ..Default::default() })
        .unwrap()
        .unwrap();
    db::create_snippet(
        &conn,
        &SnippetInput {
            name: Some("grouped".into()),
            content: Some("x".into()),
            group_id: Some(Some(g.id)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(db::list_snippets(&conn, GroupFilter::Global).unwrap().len(), 1);
    assert_eq!(db::list_snippets(&conn, GroupFilter::Id(g.id)).unwrap().len(), 1);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn theme_default_is_unique() {
    let (conn, dir) = temp_db();
    let t1 = db::create_theme(
        &conn,
        &ThemeInput {
            name: Some("Dark".into()),
            colors: Some(serde_json::json!({"background": "#000"}).as_object().unwrap().clone()),
            is_default: Some(true),
        },
    )
    .unwrap();
    assert!(t1.is_default);
    let t2 = db::create_theme(
        &conn,
        &ThemeInput {
            name: Some("Light".into()),
            colors: Some(serde_json::json!({"background": "#fff"}).as_object().unwrap().clone()),
            is_default: Some(true),
        },
    )
    .unwrap();
    assert!(t2.is_default);
    let all = db::list_themes(&conn).unwrap();
    assert_eq!(all.len(), 2);
    let defaults: Vec<_> = all.iter().filter(|t| t.is_default).collect();
    assert_eq!(defaults.len(), 1);
    assert_eq!(defaults[0].id, t2.id);
    assert_eq!(defaults[0].colors["background"], "#fff");
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn settings_roundtrip() {
    let (conn, dir) = temp_db();
    assert!(db::get_setting(&conn, "theme").unwrap().is_none());
    db::set_setting(&conn, "theme", "dark").unwrap();
    assert_eq!(db::get_setting(&conn, "theme").unwrap().as_deref(), Some("dark"));
    db::set_setting(&conn, "theme", "light").unwrap();
    assert_eq!(db::get_setting(&conn, "theme").unwrap().as_deref(), Some("light"));
    assert_eq!(db::list_settings(&conn).unwrap().len(), 1);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn known_host_upsert() {
    let (conn, dir) = temp_db();
    let first = db::upsert_known_host(&conn, "example.com", 22, "ssh-ed25519", "AAAA").unwrap();
    assert!(first.id > 0);
    let second = db::upsert_known_host(&conn, "example.com", 22, "ssh-ed25519", "BBBB").unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(second.fingerprint, "BBBB");
    assert_eq!(db::list_known_hosts(&conn).unwrap().len(), 1);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn token_verify_flow() {
    let (conn, dir) = temp_db();
    assert!(!db::has_active_token(&conn));
    let (token, hash) = tokens::generate_token();
    let record = db::create_app_password(&conn, "test", "*", &hash).unwrap();
    assert!(db::has_active_token(&conn));
    assert!(!record.revoked);

    let verified = db::verify_token(&conn, &token).unwrap().unwrap();
    assert_eq!(verified.id, record.id);
    // verify_token touches last_used_at (parity with the old TS server).
    let after = db::list_app_passwords(&conn).unwrap();
    assert!(after.iter().find(|p| p.id == record.id).unwrap().last_used_at.is_some());

    assert!(db::verify_token(&conn, "tfp_bogus").unwrap().is_none());

    db::revoke_app_password(&conn, record.id).unwrap();
    assert!(db::verify_token(&conn, &token).unwrap().is_none());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn bootstrap_only_on_fresh_db() {
    let (conn, dir) = temp_db();
    let first = tokens::ensure_bootstrap_token(&conn);
    assert!(first.is_some());
    let second = tokens::ensure_bootstrap_token(&conn);
    assert!(second.is_none());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn forwards_crud() {
    let (conn, dir) = temp_db();
    let host = db::create_host(
        &conn,
        &HostInput {
            name: Some("f".into()),
            host: Some("h".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let fw = db::create_forward(
        &conn,
        &PortForwardInput {
            host_id: host.id,
            local_port: 8080,
            remote_host: None,
            remote_port: 80,
            protocol: None,
            auto_start: Some(true),
        },
    )
    .unwrap();
    assert_eq!(fw.remote_host, "127.0.0.1");
    assert!(fw.auto_start);
    assert_eq!(db::list_forwards(&conn, Some(host.id)).unwrap().len(), 1);
    db::delete_forward(&conn, fw.id).unwrap();
    assert!(db::list_forwards(&conn, None).unwrap().is_empty());
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn audit_records_and_orders() {
    let (conn, dir) = temp_db();
    db::add_audit(&conn, "one", None, "first").unwrap();
    db::add_audit(&conn, "two", Some(3), "second").unwrap();
    let rows = db::list_audit(&conn, 10).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].action, "two");
    assert_eq!(rows[0].host_id, Some(3));
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_db_opens_with_migrations() {
    // A database created with the OLD TS schema (no vnc_* columns) must open.
    let dir = std::env::temp_dir().join(format!("free-legacy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER, name TEXT NOT NULL, host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL DEFAULT 'root',
                auth_method TEXT NOT NULL DEFAULT 'password', password TEXT, private_key TEXT,
                pass_phrase TEXT, remote_command TEXT, keepalive INTEGER NOT NULL DEFAULT 30,
                color TEXT NOT NULL DEFAULT '#0ea5e9', favorite INTEGER NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO hosts (name, host) VALUES ('old-host', 'legacy.example.com');",
        )
        .unwrap();
    }
    let conn = db::init_db(&path).unwrap();
    let hosts = db::list_hosts(&conn).unwrap();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].name, "old-host");
    assert_eq!(hosts[0].connection_type, "ssh");
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}
