//! Bounded, AniList-CDN-only offline artwork cache.
use crate::commands::Db;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use tauri::State;

fn valid_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("s4.anilist.co") && u.port().is_none() && u.username().is_empty() && u.password().is_none())
}

fn init(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS artwork_cache (url TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, saved_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS artwork_cache_age ON artwork_cache(saved_at);").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_cached_artwork(state: State<'_, Db>, url: String) -> Result<Option<String>, String> {
    if !valid_url(&url) { return Ok(None); }
    let conn = state.lock().map_err(|_| "Database is busy")?;
    init(&conn)?;
    let value: Option<(String, Vec<u8>)> = conn.query_row("SELECT mime, data FROM artwork_cache WHERE url = ?1", [&url], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    Ok(value.map(|(mime, data)| format!("data:{mime};base64,{}", STANDARD.encode(data))))
}

#[tauri::command]
pub async fn cache_artwork(state: State<'_, Db>, url: String) -> Result<(), String> {
    if !valid_url(&url) { return Err("Artwork host is not allowed".into()); }
    {
        let conn = state.lock().map_err(|_| "Database is busy")?;
        init(&conn)?;
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM artwork_cache WHERE url = ?1)", [&url], |r| r.get(0)).map_err(|e| e.to_string())?;
        if exists { return Ok(()); }
    }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(&url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_string();
    if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif") { return Err("Unsupported artwork type".into()); }
    if response.content_length().is_some_and(|n| n > 5_000_000) { return Err("Artwork is too large".into()); }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if data.len() + chunk.len() > 5_000_000 { return Err("Artwork is too large".into()); }
        data.extend_from_slice(&chunk);
    }
    let conn = state.lock().map_err(|_| "Database is busy")?;
    conn.execute("INSERT OR REPLACE INTO artwork_cache(url,mime,data,saved_at) VALUES (?1,?2,?3,unixepoch())", params![url, mime, data]).map_err(|e| e.to_string())?;
    // Retain at most 300 files and 50 MB, evicting oldest first.
    conn.execute("DELETE FROM artwork_cache WHERE url IN (SELECT url FROM (SELECT url, ROW_NUMBER() OVER (ORDER BY saved_at DESC, rowid DESC) AS n, SUM(length(data)) OVER (ORDER BY saved_at DESC, rowid DESC) AS bytes FROM artwork_cache) WHERE n > 300 OR bytes > 50000000)", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_url;
    #[test]
    fn only_anilist_https_cdn_is_allowed() {
        assert!(valid_url("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/example.jpg"));
        assert!(!valid_url("http://s4.anilist.co/example.jpg"));
        assert!(!valid_url("https://s4.anilist.co.evil.example/example.jpg"));
        assert!(!valid_url("https://user@s4.anilist.co/example.jpg"));
        assert!(!valid_url("https://s4.anilist.co:444/example.jpg"));
    }
}
