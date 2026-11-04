//! Discovery requests run in the user's provider webview, after manual verification.
//! The remote page is not granted Tauri permissions and cookies never leave it.
use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct VerificationState {
    pub waiting: AtomicBool,
    pub probing: AtomicBool,
}

fn provider_url(url: &url::Url) -> bool {
    url.scheme() == "https" && matches!(url.host_str(), Some("animepahe.com" | "animepahe.pw"))
}

fn session_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

async fn eval(window: &tauri::WebviewWindow, script: String) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    window.eval_with_callback(script, move |result| {
        if let Ok(mut sender) = tx.lock() {
            if let Some(sender) = sender.take() { let _ = sender.send(result); }
        }
    })
        .map_err(|e| format!("Provider window error: {e}"))?;
    let result = tokio::time::timeout(Duration::from_secs(3), rx).await
        .map_err(|_| "Provider window did not respond".to_string())?
        .map_err(|_| "Provider window closed".to_string())?;
    serde_json::from_str(&result).map_err(|_| "Invalid response from provider window".to_string())
}

async fn request(app: tauri::AppHandle, query: Vec<(&str, String)>) -> Result<serde_json::Value, String> {
    let window = app.get_webview_window("animepahe").ok_or("Open AnimePahe and complete verification first")?;
    request_in_window(&window, query).await
}

async fn request_in_window(window: &tauri::WebviewWindow, query: Vec<(&str, String)>) -> Result<serde_json::Value, String> {
    let current = window.url().map_err(|e| e.to_string())?;
    if !provider_url(&current) { return Err("Return to AnimePahe and complete verification first".into()); }
    let params: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(query).finish();
    let path = serde_json::to_string(&format!("/api?{params}")).map_err(|e| e.to_string())?;
    let key = format!("__megu_{:016x}", rand::random::<u64>());
    let key_js = serde_json::to_string(&key).map_err(|e| e.to_string())?;
    let start = format!(r#"(() => {{
      if (location.protocol !== 'https:' || !['animepahe.com','animepahe.pw'].includes(location.hostname)) return false;
      const key = {key_js}; window[key] = null;
      fetch({path}, {{credentials:'same-origin', headers:{{'Accept':'application/json','X-Requested-With':'XMLHttpRequest'}}}})
        .then(async r => {{ if (!r.ok) throw new Error('Provider returned HTTP ' + r.status); return await r.json(); }})
        .then(data => {{ window[key] = {{data}}; }})
        .catch(() => {{ window[key] = {{error:'Provider request failed. Complete verification in the AnimePahe window and try again.'}}; }});
      return true;
    }})()"#);
    if eval(&window, start).await? != serde_json::Value::Bool(true) {
        return Err("Return to AnimePahe and complete verification first".into());
    }
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if !provider_url(&window.url().map_err(|e| e.to_string())?) { return Err("Provider window navigated away".into()); }
        let value = eval(&window, format!("(() => {{ const v = window[{key_js}]; if (v) delete window[{key_js}]; return v || null; }})()")).await?;
        if let Some(error) = value.get("error").and_then(|x| x.as_str()) { return Err(error.to_string()); }
        if let Some(data) = value.get("data") {
            if !data.get("data").is_some_and(|v| v.is_array()) { return Err("Unexpected AnimePahe response".into()); }
            return Ok(data.clone());
        }
    }
    let _ = window.eval(format!("delete window[{key_js}]"));
    Err("AnimePahe did not respond. Complete verification and try again.".into())
}

/// Wait for the user's verification to complete. A successful same-origin API
/// response, not merely a page load or the presence of a cookie, proves that
/// the provider is usable. This never solves the challenge on the user's behalf.
pub async fn detect_verification(window: tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let state = app.state::<VerificationState>();
    if !state.waiting.load(Ordering::SeqCst) || state.probing.swap(true, Ordering::SeqCst) { return; }
    for _ in 0..36 {
        if !state.waiting.load(Ordering::SeqCst) { break; }
        let current = match window.url() { Ok(url) => url, Err(_) => break };
        if provider_url(&current) && current.path() == "/" {
            if let Ok(data) = request_in_window(&window, vec![("m", "airing".into()), ("page", "1".into())]).await {
                // Do not hide a window the user has navigated to for playback.
                if window.url().ok().is_some_and(|url| provider_url(&url) && url.path() == "/")
                    && state.waiting.swap(false, Ordering::SeqCst) {
                    let _ = window.hide();
                    let _ = app.emit_to("main", "animepahe-ready", data);
                }
                break;
            }
        } else if provider_url(&current) && current.path().starts_with("/play/") {
            state.waiting.store(false, Ordering::SeqCst);
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    state.probing.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub async fn animepahe_search(app: tauri::AppHandle, query: String, page: u32) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 || !(1..=1000).contains(&page) { return Err("Invalid search".into()); }
    request(app, vec![("m", "search".into()), ("q", query.into()), ("page", page.to_string())]).await
}

#[tauri::command]
pub async fn animepahe_airing(app: tauri::AppHandle, page: u32) -> Result<serde_json::Value, String> {
    if !(1..=1000).contains(&page) { return Err("Invalid page".into()); }
    request(app, vec![("m", "airing".into()), ("page", page.to_string())]).await
}

#[tauri::command]
pub async fn animepahe_episodes(app: tauri::AppHandle, session: String, page: u32) -> Result<serde_json::Value, String> {
    if !session_id(&session) || !(1..=1000).contains(&page) { return Err("Invalid anime or page".into()); }
    request(app, vec![("m", "release".into()), ("id", session), ("sort", "episode_asc".into()), ("page", page.to_string())]).await
}

#[tauri::command]
pub async fn animepahe_play(app: tauri::AppHandle, anime: String, episode: String) -> Result<(), String> {
    if !session_id(&anime) || !session_id(&episode) { return Err("Invalid episode".into()); }
    let window = app.get_webview_window("animepahe").ok_or("Open AnimePahe and complete verification first")?;
    let current = window.url().map_err(|e| e.to_string())?;
    if !provider_url(&current) { return Err("Return to AnimePahe and complete verification first".into()); }
    let target = current.join(&format!("/play/{anime}/{episode}")).map_err(|e| e.to_string())?;
    window.navigate(target).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn validates_sessions() {
        assert!(session_id("abc-123"));
        assert!(!session_id("../foo"));
        assert!(!session_id(""));
    }
    #[test] fn restricts_provider_origin() {
        assert!(provider_url(&url::Url::parse("https://animepahe.pw/").unwrap()));
        assert!(!provider_url(&url::Url::parse("https://animepahe.pw.evil.test/").unwrap()));
        assert!(!provider_url(&url::Url::parse("http://animepahe.pw/").unwrap()));
    }
}
