use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::models::*;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS host_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  color TEXT NOT NULL DEFAULT '#6c5ce7',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT 'root',
  connection_type TEXT NOT NULL DEFAULT 'ssh',
  agent_forward INTEGER NOT NULL DEFAULT 0,
  auth_method TEXT NOT NULL DEFAULT 'password',
  password TEXT,
  private_key TEXT,
  pass_phrase TEXT,
  remote_command TEXT,
  keepalive INTEGER NOT NULL DEFAULT 30,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  protected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  colors TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  host_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS port_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  local_port INTEGER NOT NULL,
  remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
  remote_port INTEGER NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'tcp',
  auto_start INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS known_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'unknown',
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (host, port)
);

CREATE TABLE IF NOT EXISTS app_passwords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
);

CREATE TABLE IF NOT EXISTS sync_queue (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);
CREATE INDEX IF NOT EXISTS idx_forwards_host ON port_forwards(host_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
"#;

const MIGRATIONS: &[&str] = &[
    "ALTER TABLE snippets ADD COLUMN group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL",
    "ALTER TABLE snippets ADD COLUMN protected INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE hosts ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'ssh'",
    "ALTER TABLE hosts ADD COLUMN agent_forward INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE hosts ADD COLUMN vnc_transport TEXT DEFAULT 'ssh'",
    "ALTER TABLE hosts ADD COLUMN vnc_port INTEGER",
    "ALTER TABLE hosts ADD COLUMN vnc_password TEXT",
    "ALTER TABLE hosts ADD COLUMN vnc_ssh_host_id INTEGER",
    "ALTER TABLE hosts ADD COLUMN vnc_display INTEGER",
    "ALTER TABLE hosts ADD COLUMN vnc_desktop_mode TEXT DEFAULT 'auto'",
    "ALTER TABLE hosts ADD COLUMN vnc_auto_start INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE hosts ADD COLUMN vnc_auto_stop INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE hosts ADD COLUMN vnc_implementation TEXT DEFAULT 'auto'",
];

pub fn init_db(path: &std::path::Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    for migration in MIGRATIONS {
        let _ = conn.execute(migration, []);
    }
    Ok(conn)
}

fn get_bool(row: &rusqlite::Row, col: &str) -> rusqlite::Result<bool> {
    let v: i64 = row.get(col)?;
    Ok(v != 0)
}

fn get_opt_i64(row: &rusqlite::Row, col: &str) -> rusqlite::Result<Option<i64>> {
    row.get::<_, Option<i64>>(col)
}

fn get_opt_str(row: &rusqlite::Row, col: &str) -> rusqlite::Result<Option<String>> {
    row.get::<_, Option<String>>(col)
}

fn map_host(row: &rusqlite::Row) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get("id")?,
        group_id: get_opt_i64(row, "group_id")?,
        name: row.get("name")?,
        host: row.get("host")?,
        port: row.get("port")?,
        username: row.get("username")?,
        connection_type: get_opt_str(row, "connection_type")?.unwrap_or_else(|| "ssh".into()),
        agent_forward: get_bool(row, "agent_forward").unwrap_or(false),
        auth_method: row.get("auth_method")?,
        password: get_opt_str(row, "password")?,
        private_key: get_opt_str(row, "private_key")?,
        pass_phrase: get_opt_str(row, "pass_phrase")?,
        remote_command: get_opt_str(row, "remote_command")?,
        keepalive: row.get("keepalive")?,
        color: row.get("color")?,
        favorite: get_bool(row, "favorite").unwrap_or(false),
        notes: row.get("notes")?,
        vnc_transport: get_opt_str(row, "vnc_transport")?,
        vnc_port: get_opt_i64(row, "vnc_port")?,
        vnc_password: get_opt_str(row, "vnc_password")?,
        vnc_ssh_host_id: get_opt_i64(row, "vnc_ssh_host_id")?,
        vnc_display: get_opt_i64(row, "vnc_display")?,
        vnc_desktop_mode: get_opt_str(row, "vnc_desktop_mode")?,
        vnc_auto_start: get_bool(row, "vnc_auto_start").unwrap_or(false),
        vnc_auto_stop: get_bool(row, "vnc_auto_stop").unwrap_or(false),
        vnc_implementation: get_opt_str(row, "vnc_implementation")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_group(row: &rusqlite::Row) -> rusqlite::Result<HostGroup> {
    Ok(HostGroup {
        id: row.get("id")?,
        name: row.get("name")?,
        parent_id: get_opt_i64(row, "parent_id")?,
        color: row.get("color")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_snippet(row: &rusqlite::Row) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: row.get("id")?,
        name: row.get("name")?,
        content: row.get("content")?,
        tags: row.get("tags")?,
        favorite: get_bool(row, "favorite").unwrap_or(false),
        group_id: get_opt_i64(row, "group_id")?,
        protected_: get_bool(row, "protected").unwrap_or(false),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_theme(row: &rusqlite::Row) -> rusqlite::Result<Theme> {
    let colors: String = row.get("colors")?;
    let colors = serde_json::from_str(&colors).unwrap_or_else(|_| serde_json::Map::new());
    Ok(Theme {
        id: row.get("id")?,
        name: row.get("name")?,
        colors,
        is_default: get_bool(row, "is_default").unwrap_or(false),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_audit(row: &rusqlite::Row) -> rusqlite::Result<AuditLog> {
    Ok(AuditLog {
        id: row.get("id")?,
        action: row.get("action")?,
        host_id: get_opt_i64(row, "host_id")?,
        detail: row.get("detail")?,
        created_at: row.get("created_at")?,
    })
}

fn map_known_host(row: &rusqlite::Row) -> rusqlite::Result<KnownHost> {
    Ok(KnownHost {
        id: row.get("id")?,
        host: row.get("host")?,
        port: row.get("port")?,
        key_type: row.get("key_type")?,
        fingerprint: row.get("fingerprint")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_forward(row: &rusqlite::Row) -> rusqlite::Result<PortForward> {
    Ok(PortForward {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        local_port: row.get("local_port")?,
        remote_host: row.get("remote_host")?,
        remote_port: row.get("remote_port")?,
        protocol: row.get("protocol")?,
        auto_start: get_bool(row, "auto_start").unwrap_or(false),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_app_password(row: &rusqlite::Row) -> rusqlite::Result<AppPassword> {
    Ok(AppPassword {
        id: row.get("id")?,
        name: row.get("name")?,
        scope: row.get("scope")?,
        revoked: get_bool(row, "revoked").unwrap_or(false),
        created_at: row.get("created_at")?,
        last_used_at: get_opt_str(row, "last_used_at")?,
    })
}

// ---- sync queue (parity with the old server; unused until sync returns) ----

pub fn mark_dirty(conn: &Connection, entity_type: &str, id: &str) -> rusqlite::Result<()> {
    if entity_type == "setting" && id.starts_with("sync.") {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO sync_queue (type, id) VALUES (?1, ?2) ON CONFLICT(type, id) DO NOTHING",
        params![entity_type, id],
    )?;
    Ok(())
}

// ---- hosts ----

pub fn list_hosts(conn: &Connection) -> rusqlite::Result<Vec<Host>> {
    let mut stmt = conn.prepare("SELECT * FROM hosts ORDER BY favorite DESC, name ASC")?;
    let rows = stmt.query_map([], map_host)?;
    rows.collect()
}

pub fn get_host(conn: &Connection, id: i64) -> rusqlite::Result<Option<Host>> {
    conn.query_row("SELECT * FROM hosts WHERE id = ?1", params![id], map_host)
        .optional()
}

pub fn create_host(conn: &Connection, input: &HostInput) -> rusqlite::Result<Host> {
    let name = input.name.clone().unwrap_or_default();
    let host = input.host.clone().unwrap_or_default();
    let is_vnc = input.connection_type.as_deref().unwrap_or("ssh") == "vnc";
    conn.execute(
        "INSERT INTO hosts (name, host, port, username, connection_type, agent_forward, auth_method, password, private_key, pass_phrase, remote_command, keepalive, color, favorite, notes, group_id, vnc_transport, vnc_port, vnc_password, vnc_ssh_host_id, vnc_display, vnc_desktop_mode, vnc_auto_start, vnc_auto_stop, vnc_implementation)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            name,
            host,
            input.port.unwrap_or(22),
            input.username.clone().unwrap_or_else(|| "root".into()),
            input.connection_type.clone().unwrap_or_else(|| "ssh".into()),
            input.agent_forward.unwrap_or(false) as i64,
            input.auth_method.clone().unwrap_or_else(|| "password".into()),
            input.password.as_ref().and_then(|p| p.clone()),
            input.private_key.as_ref().and_then(|p| p.clone()),
            input.pass_phrase.as_ref().and_then(|p| p.clone()),
            input.remote_command.as_ref().and_then(|p| p.clone()),
            input.keepalive.unwrap_or(30),
            input.color.clone().unwrap_or_else(|| "#0ea5e9".into()),
            input.favorite.unwrap_or(false) as i64,
            input.notes.clone().unwrap_or_default(),
            input.group_id.and_then(|g| g),
            if is_vnc { Some(input.vnc_transport.clone().unwrap_or_else(|| "ssh".into())) } else { None },
            if is_vnc { Some(input.vnc_port.and_then(|p| p).unwrap_or(5900)) } else { None },
            input.vnc_password.as_ref().and_then(|p| p.clone()),
            input.vnc_ssh_host_id.and_then(|v| v),
            input.vnc_display.and_then(|v| v),
            if is_vnc { Some(input.vnc_desktop_mode.clone().unwrap_or_else(|| "auto".into())) } else { None },
            if is_vnc && input.vnc_auto_start != Some(false) { 1 } else { 0 },
            if input.vnc_auto_stop.unwrap_or(false) { 1 } else { 0 },
            if is_vnc { Some(input.vnc_implementation.clone().unwrap_or_else(|| "auto".into())) } else { None },
        ],
    )?;
    let id = conn.last_insert_rowid();
    mark_dirty(conn, "host", &id.to_string())?;
    get_host(conn, id)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

pub fn update_host(
    conn: &Connection,
    id: i64,
    input: &HostInput,
) -> rusqlite::Result<Option<Host>> {
    let Some(existing) = get_host(conn, id)? else {
        return Ok(None);
    };
    let pick_str = |new: &Option<String>, old: &str| new.clone().unwrap_or_else(|| old.to_string());
    let pick_i64 = |new: Option<i64>, old: i64| new.unwrap_or(old);
    let pick_bool = |new: Option<bool>, old: bool| new.unwrap_or(old);

    let password = input
        .password
        .clone()
        .unwrap_or_else(|| existing.password.clone());
    let private_key = input
        .private_key
        .clone()
        .unwrap_or_else(|| existing.private_key.clone());
    let pass_phrase = input
        .pass_phrase
        .clone()
        .unwrap_or_else(|| existing.pass_phrase.clone());
    let remote_command = input
        .remote_command
        .clone()
        .unwrap_or_else(|| existing.remote_command.clone());
    let group_id = input.group_id.clone().unwrap_or(existing.group_id);
    let vnc_password = input
        .vnc_password
        .clone()
        .unwrap_or_else(|| existing.vnc_password.clone());
    let vnc_ssh_host_id = input
        .vnc_ssh_host_id
        .clone()
        .unwrap_or(existing.vnc_ssh_host_id);
    let vnc_display = input.vnc_display.clone().unwrap_or(existing.vnc_display);
    let vnc_port = input.vnc_port.clone().unwrap_or(existing.vnc_port);

    conn.execute(
        "UPDATE hosts SET name = ?1, host = ?2, port = ?3, username = ?4, connection_type = ?5, agent_forward = ?6, auth_method = ?7, password = ?8, private_key = ?9, pass_phrase = ?10, remote_command = ?11, keepalive = ?12, color = ?13, favorite = ?14, notes = ?15, group_id = ?16, vnc_transport = ?17, vnc_port = ?18, vnc_password = ?19, vnc_ssh_host_id = ?20, vnc_display = ?21, vnc_desktop_mode = ?22, vnc_auto_start = ?23, vnc_auto_stop = ?24, vnc_implementation = ?25, updated_at = datetime('now') WHERE id = ?26",
        params![
            pick_str(&input.name, &existing.name),
            pick_str(&input.host, &existing.host),
            pick_i64(input.port, existing.port),
            pick_str(&input.username, &existing.username),
            pick_str(&input.connection_type, &existing.connection_type),
            pick_bool(input.agent_forward, existing.agent_forward) as i64,
            pick_str(&input.auth_method, &existing.auth_method),
            password,
            private_key,
            pass_phrase,
            remote_command,
            pick_i64(input.keepalive, existing.keepalive),
            pick_str(&input.color, &existing.color),
            pick_bool(input.favorite, existing.favorite) as i64,
            pick_str(&input.notes, &existing.notes),
            group_id,
            input.vnc_transport.clone().or_else(|| existing.vnc_transport.clone()),
            vnc_port,
            vnc_password,
            vnc_ssh_host_id,
            vnc_display,
            input.vnc_desktop_mode.clone().or_else(|| existing.vnc_desktop_mode.clone()),
            pick_bool(input.vnc_auto_start, existing.vnc_auto_start) as i64,
            pick_bool(input.vnc_auto_stop, existing.vnc_auto_stop) as i64,
            input.vnc_implementation.clone().or_else(|| existing.vnc_implementation.clone()),
            id,
        ],
    )?;
    mark_dirty(conn, "host", &id.to_string())?;
    get_host(conn, id)
}

pub fn delete_host(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
    mark_dirty(conn, "host", &id.to_string())?;
    Ok(())
}

// ---- groups ----

pub fn list_groups(conn: &Connection) -> rusqlite::Result<Vec<HostGroup>> {
    let mut stmt = conn.prepare("SELECT * FROM host_groups ORDER BY name ASC")?;
    let rows = stmt.query_map([], map_group)?;
    rows.collect()
}

fn group_parent_exists(conn: &Connection, parent_id: Option<i64>) -> rusqlite::Result<bool> {
    match parent_id {
        None => Ok(true),
        Some(id) => {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM host_groups WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        }
    }
}

fn is_descendant(conn: &Connection, ancestor: i64, candidate: i64) -> rusqlite::Result<bool> {
    let mut current = Some(candidate);
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        if id == ancestor {
            return Ok(true);
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM host_groups WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(false)
}

pub fn create_group(conn: &Connection, input: &GroupInput) -> rusqlite::Result<Option<HostGroup>> {
    let parent_id = input.parent_id.and_then(|p| p);
    if !group_parent_exists(conn, parent_id)? {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO host_groups (name, parent_id, color) VALUES (?1, ?2, ?3)",
        params![
            input.name.clone().unwrap_or_default(),
            parent_id,
            input.color.clone().unwrap_or_else(|| "#6c5ce7".into())
        ],
    )?;
    let id = conn.last_insert_rowid();
    mark_dirty(conn, "group", &id.to_string())?;
    Ok(Some(
        conn.query_row("SELECT * FROM host_groups WHERE id = ?1", params![id], map_group)?,
    ))
}

pub fn update_group(
    conn: &Connection,
    id: i64,
    input: &GroupInput,
) -> rusqlite::Result<Option<HostGroup>> {
    let Some(existing) = conn
        .query_row("SELECT * FROM host_groups WHERE id = ?1", params![id], map_group)
        .optional()?
    else {
        return Ok(None);
    };
    let parent_id = input.parent_id.clone().unwrap_or(existing.parent_id);
    if let Some(pid) = parent_id {
        if pid == id || !group_parent_exists(conn, Some(pid))? || is_descendant(conn, id, pid)? {
            return Ok(None);
        }
    }
    conn.execute(
        "UPDATE host_groups SET name = ?1, parent_id = ?2, color = ?3, updated_at = datetime('now') WHERE id = ?4",
        params![
            input.name.clone().unwrap_or(existing.name),
            parent_id,
            input.color.clone().unwrap_or(existing.color),
            id
        ],
    )?;
    mark_dirty(conn, "group", &id.to_string())?;
    Ok(Some(
        conn.query_row("SELECT * FROM host_groups WHERE id = ?1", params![id], map_group)?,
    ))
}

pub fn delete_group(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM host_groups WHERE id = ?1", params![id])?;
    mark_dirty(conn, "group", &id.to_string())?;
    Ok(())
}

pub struct KeyMaterial {
    pub name: String,
    pub private_key: String,
    pub pass_phrase: Option<String>,
}

/// Parity with `getKeyMaterial` in server/db.ts: every distinct host private
/// key, used by the in-app ssh-agent (agent forwarding).
pub fn get_key_material(conn: &Connection) -> rusqlite::Result<Vec<KeyMaterial>> {
    let mut stmt = conn.prepare(
        "SELECT name, private_key, pass_phrase FROM hosts WHERE private_key IS NOT NULL AND private_key != ''",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let (name, private_key, pass_phrase) = row?;
        if !seen.insert(private_key.clone()) {
            continue;
        }
        out.push(KeyMaterial { name, private_key, pass_phrase });
    }
    Ok(out)
}

// ---- snippets ----

pub fn list_snippets(
    conn: &Connection,
    group_filter: GroupFilter,
) -> rusqlite::Result<Vec<Snippet>> {
    let (sql, param) = match group_filter {
        GroupFilter::All => ("SELECT * FROM snippets", None),
        GroupFilter::Global => ("SELECT * FROM snippets WHERE group_id IS NULL", None),
        GroupFilter::Id(id) => ("SELECT * FROM snippets WHERE group_id = ?1", Some(id)),
    };
    let sql = format!("{sql} ORDER BY favorite DESC, name ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = match param {
        Some(id) => stmt.query_map(params![id], map_snippet)?,
        None => stmt.query_map([], map_snippet)?,
    };
    rows.collect()
}

pub enum GroupFilter {
    All,
    Global,
    Id(i64),
}

pub fn get_snippet(conn: &Connection, id: i64) -> rusqlite::Result<Option<Snippet>> {
    conn.query_row("SELECT * FROM snippets WHERE id = ?1", params![id], map_snippet)
        .optional()
}

pub fn create_snippet(conn: &Connection, input: &SnippetInput) -> rusqlite::Result<Snippet> {
    conn.execute(
        "INSERT INTO snippets (name, content, tags, favorite, group_id, protected) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            input.name.clone().unwrap_or_default(),
            input.content.clone().unwrap_or_default(),
            input.tags.clone().unwrap_or_default(),
            input.favorite.unwrap_or(false) as i64,
            input.group_id.and_then(|g| g),
            input.protected_.unwrap_or(false) as i64,
        ],
    )?;
    let id = conn.last_insert_rowid();
    mark_dirty(conn, "snippet", &id.to_string())?;
    conn.query_row("SELECT * FROM snippets WHERE id = ?1", params![id], map_snippet)
}

pub fn update_snippet(
    conn: &Connection,
    id: i64,
    input: &SnippetInput,
) -> rusqlite::Result<Option<Snippet>> {
    let Some(existing) = get_snippet(conn, id)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE snippets SET name = ?1, content = ?2, tags = ?3, favorite = ?4, group_id = ?5, protected = ?6, updated_at = datetime('now') WHERE id = ?7",
        params![
            input.name.clone().unwrap_or(existing.name),
            input.content.clone().unwrap_or(existing.content),
            input.tags.clone().unwrap_or(existing.tags),
            input.favorite.unwrap_or(existing.favorite) as i64,
            input.group_id.clone().unwrap_or(existing.group_id),
            input.protected_.unwrap_or(existing.protected_) as i64,
            id
        ],
    )?;
    mark_dirty(conn, "snippet", &id.to_string())?;
    get_snippet(conn, id)
}

pub fn delete_snippet(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
    mark_dirty(conn, "snippet", &id.to_string())?;
    Ok(())
}

// ---- themes ----

pub fn list_themes(conn: &Connection) -> rusqlite::Result<Vec<Theme>> {
    let mut stmt = conn.prepare("SELECT * FROM themes ORDER BY is_default DESC, name ASC")?;
    let rows = stmt.query_map([], map_theme)?;
    rows.collect()
}

pub fn create_theme(conn: &Connection, input: &ThemeInput) -> rusqlite::Result<Theme> {
    if input.is_default.unwrap_or(false) {
        conn.execute("UPDATE themes SET is_default = 0", [])?;
    }
    conn.execute(
        "INSERT INTO themes (name, colors, is_default) VALUES (?1, ?2, ?3)",
        params![
            input.name.clone().unwrap_or_default(),
            serde_json::to_string(&input.colors.clone().unwrap_or_default()).unwrap_or_else(|_| "{}".into()),
            input.is_default.unwrap_or(false) as i64
        ],
    )?;
    let id = conn.last_insert_rowid();
    mark_dirty(conn, "theme", &id.to_string())?;
    conn.query_row("SELECT * FROM themes WHERE id = ?1", params![id], map_theme)
}

pub fn update_theme(
    conn: &Connection,
    id: i64,
    input: &ThemeInput,
) -> rusqlite::Result<Option<Theme>> {
    let Some(existing) = conn
        .query_row("SELECT * FROM themes WHERE id = ?1", params![id], map_theme)
        .optional()?
    else {
        return Ok(None);
    };
    if input.is_default.unwrap_or(false) {
        conn.execute("UPDATE themes SET is_default = 0", [])?;
    }
    let colors = serde_json::to_string(&input.colors.clone().unwrap_or(existing.colors))
        .unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE themes SET name = ?1, colors = ?2, is_default = ?3, updated_at = datetime('now') WHERE id = ?4",
        params![
            input.name.clone().unwrap_or(existing.name),
            colors,
            input.is_default.unwrap_or(existing.is_default) as i64,
            id
        ],
    )?;
    mark_dirty(conn, "theme", &id.to_string())?;
    conn.query_row("SELECT * FROM themes WHERE id = ?1", params![id], map_theme)
        .optional()
}

pub fn delete_theme(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM themes WHERE id = ?1", params![id])?;
    mark_dirty(conn, "theme", &id.to_string())?;
    Ok(())
}

// ---- audit ----

pub fn add_audit(
    conn: &Connection,
    action: &str,
    host_id: Option<i64>,
    detail: &str,
) -> rusqlite::Result<AuditLog> {
    conn.execute(
        "INSERT INTO audit_log (action, host_id, detail) VALUES (?1, ?2, ?3)",
        params![action, host_id, detail],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row("SELECT * FROM audit_log WHERE id = ?1", params![id], map_audit)
}

pub fn list_audit(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<AuditLog>> {
    let mut stmt = conn.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map(params![limit], map_audit)?;
    rows.collect()
}

// ---- settings ----

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    mark_dirty(conn, "setting", key)?;
    Ok(())
}

pub fn list_settings(conn: &Connection) -> rusqlite::Result<serde_json::Map<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = serde_json::Map::new();
    for row in rows {
        let (k, v) = row?;
        out.insert(k, json!(v));
    }
    Ok(out)
}

// ---- known hosts ----

pub fn list_known_hosts(conn: &Connection) -> rusqlite::Result<Vec<KnownHost>> {
    let mut stmt = conn.prepare("SELECT * FROM known_hosts ORDER BY host ASC, port ASC")?;
    let rows = stmt.query_map([], map_known_host)?;
    rows.collect()
}

pub fn get_known_host(conn: &Connection, host: &str, port: i64) -> rusqlite::Result<Option<KnownHost>> {
    conn.query_row(
        "SELECT * FROM known_hosts WHERE host = ?1 AND port = ?2",
        params![host, port],
        map_known_host,
    )
    .optional()
}

pub fn upsert_known_host(
    conn: &Connection,
    host: &str,
    port: i64,
    key_type: &str,
    fingerprint: &str,
) -> rusqlite::Result<KnownHost> {
    if let Some(existing) = get_known_host(conn, host, port)? {
        conn.execute(
            "UPDATE known_hosts SET key_type = ?1, fingerprint = ?2, updated_at = datetime('now') WHERE id = ?3",
            params![key_type, fingerprint, existing.id],
        )?;
        return get_known_host(conn, host, port)?.ok_or(rusqlite::Error::QueryReturnedNoRows);
    }
    conn.execute(
        "INSERT INTO known_hosts (host, port, key_type, fingerprint) VALUES (?1, ?2, ?3, ?4)",
        params![host, port, key_type, fingerprint],
    )?;
    get_known_host(conn, host, port)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn delete_known_host(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM known_hosts WHERE id = ?1", params![id])?;
    Ok(())
}

// ---- port forwards ----

pub fn list_forwards(conn: &Connection, host_id: Option<i64>) -> rusqlite::Result<Vec<PortForward>> {
    let mut out = match host_id {
        Some(hid) => {
            let mut stmt = conn
                .prepare("SELECT * FROM port_forwards WHERE host_id = ?1 ORDER BY local_port ASC")?;
            let rows = stmt.query_map(params![hid], map_forward)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM port_forwards ORDER BY host_id, local_port ASC")?;
            let rows = stmt.query_map([], map_forward)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    out.sort_by_key(|f| (f.host_id, f.local_port));
    Ok(out)
}

pub fn get_forward(conn: &Connection, id: i64) -> rusqlite::Result<Option<PortForward>> {
    conn.query_row("SELECT * FROM port_forwards WHERE id = ?1", params![id], map_forward)
        .optional()
}

pub fn create_forward(conn: &Connection, input: &PortForwardInput) -> rusqlite::Result<PortForward> {
    conn.execute(
        "INSERT INTO port_forwards (host_id, local_port, remote_host, remote_port, protocol, auto_start) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            input.host_id,
            input.local_port,
            input.remote_host.clone().unwrap_or_else(|| "127.0.0.1".into()),
            input.remote_port,
            input.protocol.clone().unwrap_or_else(|| "tcp".into()),
            input.auto_start.unwrap_or(false) as i64
        ],
    )?;
    let id = conn.last_insert_rowid();
    get_forward(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn delete_forward(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM port_forwards WHERE id = ?1", params![id])?;
    Ok(())
}

// ---- app passwords (scoped tokens) ----

pub fn create_app_password(
    conn: &Connection,
    name: &str,
    scope: &str,
    token_hash: &str,
) -> rusqlite::Result<AppPassword> {
    conn.execute(
        "INSERT INTO app_passwords (name, scope, token_hash) VALUES (?1, ?2, ?3)",
        params![name, scope, token_hash],
    )?;
    conn.query_row(
        "SELECT * FROM app_passwords WHERE token_hash = ?1",
        params![token_hash],
        map_app_password,
    )
}

pub fn list_app_passwords(conn: &Connection) -> rusqlite::Result<Vec<AppPassword>> {
    let mut stmt = conn.prepare("SELECT * FROM app_passwords ORDER BY id DESC")?;
    let rows = stmt.query_map([], map_app_password)?;
    rows.collect()
}

pub fn get_app_password_by_hash(
    conn: &Connection,
    token_hash: &str,
) -> rusqlite::Result<Option<AppPassword>> {
    conn.query_row(
        "SELECT * FROM app_passwords WHERE token_hash = ?1",
        params![token_hash],
        map_app_password,
    )
    .optional()
}

pub fn has_active_token(conn: &Connection) -> bool {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM app_passwords WHERE revoked = 0 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    found.is_some()
}

pub fn revoke_app_password(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE app_passwords SET revoked = 1 WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn touch_app_password(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE app_passwords SET last_used_at = datetime('now') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Verifies a plaintext token, refreshing its last-used stamp.
pub fn verify_token(conn: &Connection, token: &str) -> rusqlite::Result<Option<AppPassword>> {
    let hash = crate::tokens::hash_token(token);
    let Some(record) = get_app_password_by_hash(conn, &hash)? else {
        return Ok(None);
    };
    if record.revoked {
        return Ok(None);
    }
    touch_app_password(conn, record.id)?;
    Ok(Some(record))
}
