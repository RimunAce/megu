//! SQLite storage: anime cache, settings, and the synced AniList list.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

/// Resolve the app data directory, creating it if needed.
pub fn app_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    dir.push("megu.db");
    Ok(dir)
}

pub fn init_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = app_db_path(app)?;
    let legacy = path.parent().and_then(|p| p.parent()).ok_or("Could not locate legacy app data directory")?
        .join("com.croutonflix.app").join("croutonflix.db");
    migrate_legacy_database(&legacy, &path)?;
    let conn = Connection::open(&path).map_err(|e| format!("open db: {e}"))?;
    migrate(&conn)?;
    Ok(conn)
}

/// Copy a consistent SQLite snapshot, including committed WAL data, without
/// modifying the old installation or replacing an existing MEGU database.
fn migrate_legacy_database(legacy: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    if destination.exists() || !legacy.exists() { return Ok(()); }
    let source = Connection::open_with_flags(legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open previous app database: {e}"))?;
    let temporary = destination.with_file_name(format!("megu-migration-{:016x}.db", rand::random::<u64>()));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|e| format!("create migration file: {e}"))?;
    let result = (|| {
        source.execute("VACUUM INTO ?1", params![temporary.to_string_lossy().as_ref()])
            .map_err(|e| format!("copy previous app database: {e}"))?;
        // A hard link creates the destination only if it does not already exist.
        match std::fs::hard_link(&temporary, destination) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(format!("install migrated database: {e}")),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result?;
    Ok(())
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ddl_type: &str) -> Result<(), String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|c| c.ok())
        .collect();
    drop(stmt);
    if !cols.contains(&column.to_string()) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))
            .map_err(|e| format!("add column {column}: {e}"))?;
    }
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS anime_cache (
            id           INTEGER PRIMARY KEY,
            raw_json     TEXT NOT NULL,
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_list (
            media_id     INTEGER PRIMARY KEY,
            status       TEXT,
            progress     INTEGER DEFAULT 0,
            score        INTEGER,
            title        TEXT,
            cover        TEXT,
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS watch_progress (
            media_id     INTEGER NOT NULL,
            episode      INTEGER NOT NULL,
            position     REAL    NOT NULL DEFAULT 0,
            duration     REAL,
            last_watched TEXT,
            PRIMARY KEY (media_id, episode)
        );

        CREATE TABLE IF NOT EXISTS list_snapshots (
            user_id INTEGER PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pending_progress (
            user_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL,
            base_progress INTEGER NOT NULL,
            base_status TEXT NOT NULL,
            progress INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, media_id)
        );
        CREATE TABLE IF NOT EXISTS recent_episodes (
            user_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            anime_session TEXT NOT NULL,
            episode_session TEXT NOT NULL,
            episode REAL NOT NULL,
            opened_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, media_id)
        );
        ",
    )
    .map_err(|e| format!("migrate: {e}"))?;

    // Phase 2 display fields for list cards.
    add_column_if_missing(conn, "user_list", "episodes", "INTEGER")?;
    add_column_if_missing(conn, "user_list", "season_year", "INTEGER")?;
    add_column_if_missing(conn, "user_list", "format", "TEXT")?;
    add_column_if_missing(conn, "user_list", "average_score", "INTEGER")?;
    Ok(())
}

// ─── Settings (non-secret values like the AniList client ID) ────────────────

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("set_setting: {e}"))?;
    Ok(())
}

// ─── Anime cache ─────────────────────────────────────────────────────────────

/// Cache a raw AniList Media JSON object keyed by its ID.
pub fn cache_media(conn: &Connection, media: &Value) -> Result<(), String> {
    let id = media.get("id").and_then(Value::as_i64).ok_or("media missing id")?;
    let json = serde_json::to_string(media).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO anime_cache (id, raw_json, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET raw_json = excluded.raw_json, updated_at = datetime('now')",
        params![id, json],
    )
    .map_err(|e| format!("cache_media: {e}"))?;
    Ok(())
}

/// Is there a cached entry newer than `max_age_secs`?
pub fn is_fresh(conn: &Connection, id: i64, max_age_secs: i64) -> bool {
    conn.query_row(
        "SELECT (unixepoch('now') - unixepoch(updated_at)) < ?1 FROM anime_cache WHERE id = ?2",
        params![max_age_secs, id],
        |r| r.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

pub fn get_cached_media(conn: &Connection, id: i64) -> Result<Option<Value>, String> {
    let mut stmt = conn.prepare("SELECT raw_json FROM anime_cache WHERE id = ?1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let json: String = row.get(0).map_err(|e| e.to_string())?;
        Ok(serde_json::from_str(&json).map_err(|e| e.to_string()).ok())
    } else {
        Ok(None)
    }
}

// ─── Synced user list ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserListEntry {
    pub media_id: i64,
    pub status: String,
    pub progress: i64,
    pub score: Option<i64>,
    pub title: Option<String>,
    pub cover: Option<String>,
    pub episodes: Option<i64>,
    pub season_year: Option<i64>,
    pub format: Option<String>,
    pub average_score: Option<i64>,
    pub updated_at: Option<String>,
}

pub fn upsert_user_list(conn: &Connection, entries: &[UserListEntry]) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|e| e.to_string())?;
    for e in entries {
        conn.execute(
            "INSERT INTO user_list (media_id, status, progress, score, title, cover, episodes, season_year, format, average_score, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
             ON CONFLICT(media_id) DO UPDATE SET
               status = excluded.status, progress = excluded.progress, score = excluded.score,
               title = excluded.title, cover = excluded.cover, episodes = excluded.episodes,
               season_year = excluded.season_year, format = excluded.format,
               average_score = excluded.average_score, updated_at = datetime('now')",
            params![
                e.media_id,
                e.status,
                e.progress,
                e.score,
                e.title,
                e.cover,
                e.episodes,
                e.season_year,
                e.format,
                e.average_score
            ],
        )
        .map_err(|err| format!("upsert {}: {err}", e.media_id))?;
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_user_list(conn: &Connection) -> Result<Vec<UserListEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT media_id, status, progress, score, title, cover, episodes, season_year, format, average_score, updated_at
             FROM user_list ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(UserListEntry {
                media_id: r.get(0)?,
                status: r.get(1)?,
                progress: r.get(2)?,
                score: r.get(3)?,
                title: r.get(4)?,
                cover: r.get(5)?,
                episodes: r.get(6)?,
                season_year: r.get(7)?,
                format: r.get(8)?,
                average_score: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn update_local_entry(
    conn: &Connection,
    media_id: i64,
    status: &str,
    progress: i64,
    score: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO user_list (media_id, status, progress, score, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(media_id) DO UPDATE SET status = excluded.status, progress = excluded.progress, score = excluded.score, updated_at = datetime('now')",
        params![media_id, status, progress, score],
    )
    .map_err(|e| format!("update_local_entry: {e}"))?;
    Ok(())
}

pub fn delete_local_entry(conn: &Connection, media_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM user_list WHERE media_id = ?1", params![media_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn offline_data_is_account_scoped_and_schema_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("megu-offline-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("test.db");
        let db = Connection::open(&path).unwrap();
        migrate(&db).unwrap();
        db.execute("INSERT INTO list_snapshots(user_id,data) VALUES (1,'[1]'),(2,'[2]')", []).unwrap();
        db.execute("INSERT INTO pending_progress(user_id,media_id,base_progress,base_status,progress) VALUES (1,7,2,'CURRENT',3)", []).unwrap();
        drop(db);
        let db = Connection::open(&path).unwrap();
        let value: String = db.query_row("SELECT data FROM list_snapshots WHERE user_id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "[2]");
        let count: i64 = db.query_row("SELECT count(*) FROM pending_progress WHERE user_id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let progress: i64 = db.query_row("SELECT progress FROM pending_progress WHERE user_id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(progress, 3);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copies_committed_wal_without_overwriting_destination() {
        let dir = std::env::temp_dir().join(format!("megu-db-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&dir).unwrap();
        let old = dir.join("old.db");
        let new = dir.join("megu.db");
        let legacy = Connection::open(&old).unwrap();
        legacy.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('saved');").unwrap();
        migrate_legacy_database(&old, &new).unwrap();
        let migrated = Connection::open(&new).unwrap();
        let value: String = migrated.query_row("SELECT value FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "saved");
        migrated.execute("UPDATE items SET value='new'", []).unwrap();
        migrate_legacy_database(&old, &new).unwrap();
        let value: String = migrated.query_row("SELECT value FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "new");
        drop(migrated);
        drop(legacy);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
