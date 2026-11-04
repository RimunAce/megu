//! Tauri commands: frontend to Rust.

use crate::auth;
use crate::db::{self, UserListEntry};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

pub type Db = Mutex<rusqlite::Connection>;

fn lock<'a>(state: &'a State<'a, Db>) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.lock().map_err(|_| "Database is busy".to_string())
}

#[tauri::command]
pub fn get_db_status(app: tauri::AppHandle, state: State<'_, Db>) -> Result<DbStatus, String> {
    let conn = lock(&state)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM anime_cache", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let path = db::app_db_path(&app).map_err(|e| e.to_string())?;
    Ok(DbStatus {
        ready: true,
        cached_media: count,
        db_path: path.to_string_lossy().into_owned(),
    })
}

#[derive(Debug, Serialize)]
pub struct DbStatus {
    pub ready: bool,
    pub cached_media: i64,
    pub db_path: String,
}

#[tauri::command]
pub fn cache_media_json(state: State<'_, Db>, media: serde_json::Value) -> Result<(), String> {
    let conn = lock(&state)?;
    db::cache_media(&conn, &media)
}

#[tauri::command]
pub fn get_cached_media(state: State<'_, Db>, media_id: i64) -> Result<Option<serde_json::Value>, String> {
    let conn = lock(&state)?;
    db::get_cached_media(&conn, media_id)
}

#[tauri::command]
pub fn save_airing_feed(state: State<'_, Db>, feed: serde_json::Value) -> Result<(), String> {
    let items = feed.get("items").and_then(|v| v.as_array()).ok_or("Invalid airing feed")?;
    if items.len() > 50 || !feed.get("savedAt").is_some_and(|v| v.is_number()) { return Err("Invalid airing feed".into()); }
    let json = serde_json::to_string(&feed).map_err(|e| e.to_string())?;
    if json.len() > 300_000 { return Err("Airing feed is too large".into()); }
    let conn = lock(&state)?;
    db::set_setting(&conn, "anilist_recent_airing_feed", &json)
}

#[tauri::command]
pub fn get_airing_feed(state: State<'_, Db>) -> Result<Option<serde_json::Value>, String> {
    let conn = lock(&state)?;
    db::get_setting(&conn, "anilist_recent_airing_feed")?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string())).transpose()
}

// ─── Auth ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saved_token() -> Result<Option<String>, String> {
    auth::get_token()
}

#[tauri::command]
pub fn logout() -> Result<(), String> {
    auth::delete_token()
}

#[tauri::command]
pub fn get_client_id(state: State<'_, Db>) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    db::get_setting(&conn, "anilist_client_id")
}

#[tauri::command]
pub fn set_client_id(state: State<'_, Db>, client_id: String) -> Result<(), String> {
    let conn = lock(&state)?;
    db::set_setting(&conn, "anilist_client_id", client_id.trim())
}

// ─── Synced list ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_user_list(state: State<'_, Db>, entries: Vec<UserListEntry>) -> Result<(), String> {
    let conn = lock(&state)?;
    db::upsert_user_list(&conn, &entries)
}

#[tauri::command]
pub fn get_local_list(state: State<'_, Db>) -> Result<Vec<UserListEntry>, String> {
    let conn = lock(&state)?;
    db::get_user_list(&conn)
}

#[tauri::command]
pub fn update_local_entry(
    state: State<'_, Db>,
    media_id: i64,
    status: String,
    progress: i64,
    score: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    db::update_local_entry(&conn, media_id, &status, progress, score)
}

#[tauri::command]
pub fn delete_local_entry(state: State<'_, Db>, media_id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    db::delete_local_entry(&conn, media_id)
}

#[derive(serde::Serialize)]
pub struct PendingProgress {
    media_id: i64,
    base_progress: i64,
    base_status: String,
    progress: i64,
}

#[tauri::command]
pub fn save_list_snapshot(state: State<'_, Db>, user_id: i64, entries: serde_json::Value) -> Result<(), String> {
    if user_id <= 0 || !entries.is_array() { return Err("Invalid list snapshot".into()); }
    let conn = lock(&state)?;
    conn.execute("INSERT INTO list_snapshots(user_id,data,updated_at) VALUES (?1,?2,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", rusqlite::params![user_id, entries.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_list_snapshot(state: State<'_, Db>, user_id: i64) -> Result<Option<serde_json::Value>, String> {
    use rusqlite::OptionalExtension;
    let conn = lock(&state)?;
    let data: Option<String> = conn.query_row("SELECT data FROM list_snapshots WHERE user_id=?1", [user_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    data.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string())).transpose()
}

#[tauri::command]
pub fn queue_progress(state: State<'_, Db>, user_id: i64, media_id: i64, base_progress: i64, base_status: String, progress: i64) -> Result<(), String> {
    if user_id <= 0 || media_id <= 0 || base_progress < 0 || progress < 0 || !["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"].contains(&base_status.as_str()) { return Err("Invalid progress".into()); }
    let conn = lock(&state)?;
    conn.execute("INSERT INTO pending_progress(user_id,media_id,base_progress,base_status,progress) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(user_id,media_id) DO UPDATE SET progress=excluded.progress,updated_at=datetime('now')", rusqlite::params![user_id,media_id,base_progress,base_status,progress]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_pending_progress(state: State<'_, Db>, user_id: i64) -> Result<Vec<PendingProgress>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn.prepare("SELECT media_id,base_progress,base_status,progress FROM pending_progress WHERE user_id=?1 ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([user_id], |r| Ok(PendingProgress {media_id:r.get(0)?,base_progress:r.get(1)?,base_status:r.get(2)?,progress:r.get(3)?})).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_pending_progress(state: State<'_, Db>, user_id: i64, media_id: i64, progress: i64, base_progress: i64, base_status: String) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM pending_progress WHERE user_id=?1 AND media_id=?2 AND progress=?3 AND base_progress=?4 AND base_status=?5", rusqlite::params![user_id,media_id,progress,base_progress,base_status]).map_err(|e| e.to_string())?;
    Ok(())
}

/// A newer local edit may have arrived while a previous edit was in flight.
/// Remove only the sent edit; otherwise rebase the newer edit on the value
/// AniList just acknowledged so it is not mistaken for a remote conflict.
#[tauri::command]
pub fn complete_pending_progress(state: State<'_, Db>, user_id: i64, media_id: i64, progress: i64, base_progress: i64, base_status: String) -> Result<(), String> {
    let conn = lock(&state)?;
    complete_pending_progress_in_db(&conn, user_id, media_id, progress, base_progress, &base_status)
}

fn complete_pending_progress_in_db(conn: &rusqlite::Connection, user_id: i64, media_id: i64, progress: i64, base_progress: i64, base_status: &str) -> Result<(), String> {
    conn.execute("DELETE FROM pending_progress WHERE user_id=?1 AND media_id=?2 AND progress=?3 AND base_progress=?4 AND base_status=?5", rusqlite::params![user_id,media_id,progress,base_progress,base_status]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE pending_progress SET base_progress=?3 WHERE user_id=?1 AND media_id=?2 AND base_progress=?4 AND base_status=?5", rusqlite::params![user_id,media_id,progress,base_progress,base_status]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct RecentEpisode { media_id: i64, title: String, anime_session: String, episode_session: String, episode: f64 }

#[tauri::command]
pub fn record_recent_episode(state: State<'_, Db>, user_id: i64, media_id: i64, title: String, anime_session: String, episode_session: String, episode: f64) -> Result<(), String> {
    let valid_id = |s: &str| !s.is_empty() && s.len() <= 100 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
    if user_id <= 0 || media_id <= 0 || title.is_empty() || title.len() > 1000 || !valid_id(&anime_session) || !valid_id(&episode_session) || !episode.is_finite() || episode < 0.0 { return Err("Invalid episode".into()); }
    let conn = lock(&state)?;
    conn.execute("INSERT INTO recent_episodes(user_id,media_id,title,anime_session,episode_session,episode,opened_at) VALUES (?1,?2,?3,?4,?5,?6,datetime('now')) ON CONFLICT(user_id,media_id) DO UPDATE SET title=excluded.title,anime_session=excluded.anime_session,episode_session=excluded.episode_session,episode=excluded.episode,opened_at=datetime('now')", rusqlite::params![user_id,media_id,title,anime_session,episode_session,episode]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_recent_episodes(state: State<'_, Db>, user_id: i64) -> Result<Vec<RecentEpisode>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn.prepare("SELECT media_id,title,anime_session,episode_session,episode FROM recent_episodes WHERE user_id=?1 ORDER BY opened_at DESC LIMIT 50").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([user_id], |r| Ok(RecentEpisode {media_id:r.get(0)?,title:r.get(1)?,anime_session:r.get(2)?,episode_session:r.get(3)?,episode:r.get(4)?})).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Open an external episode link without allowing file or custom URL schemes.
#[tauri::command]
pub fn open_stream_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid episode link".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Only HTTPS episode links can be opened".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| format!("Could not open episode: {e}"))
}

fn validate_player_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid player link".to_string())?;
    let host = parsed.host_str().ok_or("Invalid player link")?.trim_end_matches('.').to_ascii_lowercase();
    let private = host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
        || host.ends_with(".internal") || host.parse::<std::net::IpAddr>().is_ok();
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.port().is_some() || private {
        return Err("Only public HTTPS player links are supported".into());
    }
    Ok(parsed)
}

#[derive(serde::Deserialize)]
pub struct PlayerBounds { x: f64, y: f64, width: f64, height: f64 }

#[tauri::command]
pub async fn show_inline_player(window: tauri::Window, url: String, bounds: PlayerBounds, resume: f64, session: String, expected_duration: Option<f64>) -> Result<(), String> {
    use tauri::Manager;
    use tauri::Emitter;
    let url = validate_player_url(&url)?;
    if let Some(old) = window.get_webview("inline-player") { old.close().map_err(|e| e.to_string())?; }
    // The provider receives no Tauri capabilities. All telemetry, including
    // messages relayed from visible player frames, remains untrusted.
    let resume = if resume.is_finite() { resume.clamp(0.0, 86400.0) } else { 0.0 };
    if session.len() > 100 || session.is_empty() { return Err("Invalid player session".into()); }
    let session_id = session.clone();
    let session = serde_json::to_string(&session).map_err(|e| e.to_string())?;
    let expected = expected_duration.filter(|v| v.is_finite() && *v > 0.0 && *v <= 86400.0).unwrap_or(0.0);
    let script = include_str!("player_probe.js")
        .replace("__MEGU_SESSION_JSON__", &session)
        .replace("__MEGU_RESUME__", &resume.to_string())
        .replace("__MEGU_EXPECTED_DURATION__", &expected.to_string());
    window.add_child(
        tauri::webview::WebviewBuilder::new("inline-player", tauri::WebviewUrl::External(url))
            .initialization_script_for_all_frames(script)
            .on_document_title_changed(move |webview, title| {
                if let Some(payload) = title.strip_prefix("__MEGU_PROGRESS__") {
                    if payload.len() > 512 { return; }
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                        if value.get("session").and_then(|v| v.as_str()) == Some(session_id.as_str()) {
                            let _ = webview.emit_to("main", "player-progress", value);
                        }
                    }
                }
            }),
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    ).map_err(|e| format!("Could not create in-app player: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn resize_inline_player(app: tauri::AppHandle, bounds: PlayerBounds) -> Result<(), String> {
    use tauri::Manager;
    if let Some(player) = app.get_webview("inline-player") {
        player.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
        player.set_size(tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_inline_player(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(player) = app.get_webview("inline-player") { player.close().map_err(|e| e.to_string())?; }
    Ok(())
}

/// Play a provider embed in its own webview. That window has no Tauri
/// capabilities, so the remote page cannot call desktop commands.
#[tauri::command]
pub async fn open_player_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::Manager;
    let parsed = validate_player_url(&url)?;
    if let Some(window) = app.get_webview_window("megu-player") {
        window.navigate(parsed).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, "megu-player", tauri::WebviewUrl::External(parsed))
        .title("MEGU player")
        .inner_size(1280.0, 800.0)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .build()
        .map_err(|e| format!("Could not open player: {e}"))?;
    Ok(())
}

/// Open the provider in its own unprivileged webview. Verification and
/// navigation are deliberately left to the user.
#[tauri::command]
pub async fn open_animepahe(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use std::sync::atomic::Ordering;
    app.state::<crate::animepahe::VerificationState>().waiting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("animepahe") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        let url = url::Url::parse("https://animepahe.pw/").map_err(|e| e.to_string())?;
        return window.navigate(url).map_err(|e| e.to_string());
    }
    let url = url::Url::parse("https://animepahe.pw/").map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, "animepahe", tauri::WebviewUrl::External(url))
        .title("AnimePahe: verify and watch")
        .inner_size(1200.0, 800.0)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                tauri::async_runtime::spawn(crate::animepahe::detect_verification(window));
            }
        })
        .build()
        .map_err(|e| format!("Could not open AnimePahe: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod player_url_tests {
    use super::{validate_player_url, complete_pending_progress_in_db};

    #[test]
    fn accepts_public_https_only() {
        assert!(validate_player_url("https://megaplay.buzz/stream/s-2/849/sub").is_ok());
        assert!(validate_player_url("http://megaplay.buzz/stream").is_err());
        assert!(validate_player_url("https://localhost/player").is_err());
        assert!(validate_player_url("https://127.0.0.1/player").is_err());
        assert!(validate_player_url("https://user:pass@megaplay.buzz/").is_err());
        assert!(validate_player_url("https://megaplay.buzz:8443/").is_err());
        assert!(validate_player_url("file:///C:/secret").is_err());
    }

    #[test]
    fn acknowledged_progress_rebases_a_newer_local_edit() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE pending_progress(user_id INTEGER,media_id INTEGER,progress INTEGER,base_progress INTEGER,base_status TEXT);
            INSERT INTO pending_progress VALUES(1,42,5,3,'CURRENT');").unwrap();
        complete_pending_progress_in_db(&db, 1, 42, 4, 3, "CURRENT").unwrap();
        let row: (i64, i64) = db.query_row("SELECT progress,base_progress FROM pending_progress", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(row, (5,4));
        complete_pending_progress_in_db(&db, 1, 42, 5, 4, "CURRENT").unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pending_progress", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
    }
}
