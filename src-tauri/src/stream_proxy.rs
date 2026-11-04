//! A per-player HLS fetcher. The renderer may fetch only the initially
//! registered HTTPS host, pinned to public DNS addresses. Redirects, cookies,
//! arbitrary request headers, local addresses and oversized bodies are denied.
use std::{collections::HashMap, net::{IpAddr, Ipv4Addr, Ipv6Addr}, sync::{Arc, Mutex}, time::Duration};
use tauri::{Manager, State};

#[derive(Clone)]
struct Session { host: String, client: reqwest::Client, referer: Option<String>, permits: Arc<tokio::sync::Semaphore> }
#[derive(Default)]
pub struct StreamSessions(Mutex<HashMap<String, Session>>);

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a,b,c,_] = ip.octets();
    !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168) || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2) || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100) || (a == 203 && b == 0 && c == 113))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}
fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() { return public_v4(v4); }
    let segments = ip.segments();
    (segments[0] & 0xe000) == 0x2000 && segments[0] != 0x2002
        && !(segments[0] == 0x2001 && (segments[1] <= 0x01ff || segments[1] == 0x0db8))
}
fn checked_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid stream URL".to_string())?;
    let host = url.host_str().ok_or("Invalid stream host")?.trim_end_matches('.').to_ascii_lowercase();
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || host.parse::<IpAddr>().is_ok() || host == "localhost" || host.ends_with(".localhost")
        || host.ends_with(".local") || host.ends_with(".internal") {
        return Err("Only public HTTPS stream URLs are supported".into());
    }
    Ok(url)
}
fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" { return Err("Stream access is restricted to MEGU".into()); }
    Ok(())
}

#[tauri::command]
pub async fn register_stream(webview: tauri::Webview, app: tauri::AppHandle, session: String, url: String, referer: Option<String>) -> Result<(), String> {
    require_main(&webview)?;
    if session.is_empty() || session.len() > 100 { return Err("Invalid stream session".into()); }
    let url = checked_url(&url)?;
    let host = url.host_str().ok_or("Invalid stream host")?.to_ascii_lowercase();
    let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), 443)).await.map_err(|_| "Could not resolve the stream host")?.collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) { return Err("Stream host did not resolve exclusively to public addresses".into()); }
    let referer = match referer {
        Some(value) if !value.is_empty() => Some(checked_url(&value)?.to_string()),
        _ => None,
    };
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addresses).connect_timeout(Duration::from_secs(12)).timeout(Duration::from_secs(45))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")
        .build().map_err(|e| format!("Could not initialize stream: {e}"))?;
    let state = app.state::<StreamSessions>();
    let mut sessions = state.0.lock().map_err(|_| "Stream session unavailable")?;
    if sessions.len() >= 4 && !sessions.contains_key(&session) { return Err("Too many active streams".into()); }
    sessions.insert(session, Session { host, client, referer, permits: Arc::new(tokio::sync::Semaphore::new(4)) });
    Ok(())
}

#[tauri::command]
pub async fn fetch_stream(webview: tauri::Webview, app: tauri::AppHandle, session: String, url: String, range_start: Option<u64>, range_end: Option<u64>) -> Result<tauri::ipc::Response, String> {
    require_main(&webview)?;
    let url = checked_url(&url)?;
    let session = app.state::<StreamSessions>().0.lock().map_err(|_| "Stream session unavailable")?.get(&session).cloned().ok_or("Stream session expired")?;
    if url.host_str().map(|h| h.eq_ignore_ascii_case(&session.host)) != Some(true) { return Err("The stream requested a different host; choose another player".into()); }
    let _permit = tokio::time::timeout(Duration::from_secs(15), session.permits.clone().acquire_owned()).await.map_err(|_| "Stream request queue timed out")?.map_err(|_| "Stream session closed")?;
    let mut request = session.client.get(url);
    if let Some(ref value) = session.referer {
        request = request.header(reqwest::header::REFERER, value);
        if let Ok(parsed) = url::Url::parse(value) { request = request.header(reqwest::header::ORIGIN, parsed.origin().ascii_serialization()); }
    }
    if let Some(start) = range_start {
        if let Some(end) = range_end { if end <= start || end - start > 16 * 1024 * 1024 { return Err("Invalid stream byte range".into()); } }
        request = request.header(reqwest::header::RANGE, match range_end { Some(end) => format!("bytes={start}-{}", end - 1), None => format!("bytes={start}-") });
    }
    let mut response = request.send().await.map_err(|_| "Could not reach the stream server".to_string())?;
    if !response.status().is_success() { return Err(format!("Stream server returned HTTP {}", response.status().as_u16())); }
    if range_start.is_some() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT { return Err("Stream server did not honor the requested byte range".into()); }
    const MAX: usize = 16 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) { return Err("Stream segment is too large".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Could not read the stream response".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX { return Err("Stream segment is too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn close_stream(webview: tauri::Webview, state: State<'_, StreamSessions>, session: String) -> Result<(), String> {
    require_main(&webview)?;
    state.0.lock().map_err(|_| "Stream session unavailable")?.remove(&session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_local_and_special_addresses() {
        for ip in ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.2", "169.254.1.2", "100.64.0.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "::ffff:127.0.0.1"] {
            assert!(!public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn restricts_url_shapes() {
        assert!(checked_url("https://cdn.example.org/master.m3u8").is_ok());
        for url in ["http://example.com", "https://localhost/a", "https://127.0.0.1/a", "https://user:pw@example.com", "https://example.com:8443/a", "file:///secret"] { assert!(checked_url(url).is_err(), "accepted {url}"); }
    }
}
