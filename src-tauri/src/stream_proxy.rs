//! A per-player HLS and direct media fetcher. The renderer may fetch only
//! public HTTPS hosts pinned to public DNS addresses, following up to 5 safe
//! redirects and allowing CDN hosts referenced by the playlist or registered
//! subtitles. Cookies, arbitrary request headers, local addresses and
//! oversized bodies are denied.
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};

#[derive(Clone)]
struct Session {
    referer: Option<String>,
    origin: Option<String>,
    user_agent: String,
    permits: Arc<tokio::sync::Semaphore>,
    allowed_hosts: Arc<Mutex<HashSet<String>>>,
    clients: Arc<Mutex<HashMap<String, reqwest::Client>>>,
}
#[derive(Default)]
pub struct StreamSessions(Mutex<HashMap<String, Session>>);

const MAX_HOSTS_PER_SESSION: usize = 24;
const MAX_REDIRECTS: usize = 5;
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}
fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let segments = ip.segments();
    (segments[0] & 0xe000) == 0x2000
        && segments[0] != 0x2002
        && !(segments[0] == 0x2001 && (segments[1] <= 0x01ff || segments[1] == 0x0db8))
}
fn checked_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid stream URL".to_string())?;
    let host = url
        .host_str()
        .ok_or("Invalid stream host")?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || host.parse::<IpAddr>().is_ok()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("Only public HTTPS stream URLs are supported".into());
    }
    Ok(url)
}
fn sanitized_user_agent(value: Option<String>) -> String {
    match value {
        Some(raw) => {
            let trimmed = raw.trim();
            if !trimmed.is_empty()
                && trimmed.len() <= 300
                && trimmed.bytes().all(|b| (0x20..=0x7e).contains(&b))
            {
                trimmed.to_string()
            } else {
                DEFAULT_UA.to_string()
            }
        }
        None => DEFAULT_UA.to_string(),
    }
}
fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Stream access is restricted to MEGU".into());
    }
    Ok(())
}

async fn resolve_public_addrs(host: &str) -> Result<Vec<SocketAddr>, String> {
    let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "Could not resolve the stream host".to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("Stream host did not resolve exclusively to public addresses".into());
    }
    Ok(addresses)
}

fn build_pinned_client(
    host: &str,
    addresses: &[SocketAddr],
    user_agent: &str,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addresses)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(45))
        .user_agent(user_agent)
        .build()
        .map_err(|e| format!("Could not initialize stream: {e}"))
}

async fn client_for_host(session: &Session, host: &str) -> Result<reqwest::Client, String> {
    let key = host.trim_end_matches('.').to_ascii_lowercase();
    if let Some(existing) = session
        .clients
        .lock()
        .map_err(|_| "Stream session unavailable")?
        .get(&key)
        .cloned()
    {
        return Ok(existing);
    }
    let addresses = resolve_public_addrs(&key).await?;
    let client = build_pinned_client(&key, &addresses, &session.user_agent)?;
    let mut map = session
        .clients
        .lock()
        .map_err(|_| "Stream session unavailable")?;
    if let Some(existing) = map.get(&key) {
        return Ok(existing.clone());
    }
    if map.len() >= MAX_HOSTS_PER_SESSION {
        return Err("Stream referenced too many hosts".into());
    }
    map.insert(key, client.clone());
    Ok(client)
}

fn extract_playlist_hosts(base: &url::Url, body: &[u8]) -> Vec<String> {
    let Ok(text) = std::str::from_utf8(body) else {
        return Vec::new();
    };
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Vec::new();
    }
    let mut hosts = Vec::new();
    let mut push_ref = |raw: &str| {
        if let Ok(resolved) = base.join(raw.trim()) {
            if let Ok(valid) = checked_url(resolved.as_str()) {
                if let Some(h) = valid.host_str() {
                    hosts.push(h.trim_end_matches('.').to_ascii_lowercase());
                }
            }
        }
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            let mut rest = trimmed;
            while let Some(idx) = rest.find("URI=\"") {
                let after = &rest[idx + 5..];
                if let Some(end) = after.find('"') {
                    push_ref(&after[..end]);
                    rest = &after[end + 1..];
                } else {
                    break;
                }
            }
        } else {
            push_ref(trimmed);
        }
    }
    hosts
}

fn allow_host(session: &Session, host: &str) -> Result<(), String> {
    let mut allowed = session
        .allowed_hosts
        .lock()
        .map_err(|_| "Stream session unavailable")?;
    if allowed.contains(host) {
        return Ok(());
    }
    if allowed.len() >= MAX_HOSTS_PER_SESSION {
        return Err("Stream referenced too many hosts".into());
    }
    allowed.insert(host.to_string());
    Ok(())
}

fn is_host_allowed(session: &Session, host: &str) -> Result<bool, String> {
    Ok(session
        .allowed_hosts
        .lock()
        .map_err(|_| "Stream session unavailable")?
        .contains(host))
}

fn resolve_redirect(current: &url::Url, location: &str) -> Result<url::Url, String> {
    let next = current
        .join(location.trim())
        .map_err(|_| "Stream redirect target was invalid".to_string())?;
    checked_url(next.as_str())
}

#[tauri::command]
pub async fn register_stream(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    session: String,
    url: String,
    referer: Option<String>,
    origin: Option<String>,
    user_agent: Option<String>,
    extra_hosts: Option<Vec<String>>,
) -> Result<(), String> {
    require_main(&webview)?;
    if session.is_empty() || session.len() > 100 {
        return Err("Invalid stream session".into());
    }
    let url = checked_url(&url)?;
    let host = url
        .host_str()
        .ok_or("Invalid stream host")?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let addresses = resolve_public_addrs(&host).await?;
    let referer = match referer {
        Some(value) if !value.is_empty() => Some(checked_url(&value)?.to_string()),
        _ => None,
    };
    let origin = match origin {
        Some(value) if !value.is_empty() => Some(checked_url(&value)?.origin().ascii_serialization()),
        _ => referer
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .map(|parsed| parsed.origin().ascii_serialization()),
    };
    let user_agent = sanitized_user_agent(user_agent);
    let client = build_pinned_client(&host, &addresses, &user_agent)?;
    let mut allowed_hosts = HashSet::new();
    allowed_hosts.insert(host.clone());
    if let Some(extras) = extra_hosts {
        for raw in extras.into_iter().take(MAX_HOSTS_PER_SESSION) {
            if let Ok(parsed) = checked_url(&raw) {
                if let Some(extra_host) = parsed.host_str() {
                    if allowed_hosts.len() < MAX_HOSTS_PER_SESSION {
                        allowed_hosts.insert(extra_host.trim_end_matches('.').to_ascii_lowercase());
                    }
                }
            }
        }
    }
    let mut clients = HashMap::new();
    clients.insert(host, client);
    let state = app.state::<StreamSessions>();
    let mut sessions = state.0.lock().map_err(|_| "Stream session unavailable")?;
    if sessions.len() >= 6 && !sessions.contains_key(&session) {
        return Err("Too many active streams".into());
    }
    sessions.insert(
        session,
        Session {
            referer,
            origin,
            user_agent,
            permits: Arc::new(tokio::sync::Semaphore::new(6)),
            allowed_hosts: Arc::new(Mutex::new(allowed_hosts)),
            clients: Arc::new(Mutex::new(clients)),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn fetch_stream(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    session: String,
    url: String,
    range_start: Option<u64>,
    range_end: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    require_main(&webview)?;
    let mut current_url = checked_url(&url)?;
    let session = app
        .state::<StreamSessions>()
        .0
        .lock()
        .map_err(|_| "Stream session unavailable")?
        .get(&session)
        .cloned()
        .ok_or("Stream session expired")?;
    let initial_host = current_url
        .host_str()
        .ok_or("Invalid stream host")?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !is_host_allowed(&session, &initial_host)? {
        return Err("The stream requested an unregistered host; choose another player".into());
    }
    let _permit = tokio::time::timeout(
        Duration::from_secs(15),
        session.permits.clone().acquire_owned(),
    )
    .await
    .map_err(|_| "Stream request queue timed out")?
    .map_err(|_| "Stream session closed")?;

    if let (Some(start), Some(end)) = (range_start, range_end) {
        if end <= start || end - start > 16 * 1024 * 1024 {
            return Err("Invalid stream byte range".into());
        }
    }

    let mut response = {
        let mut final_response = None;
        for hop in 0..=MAX_REDIRECTS {
            let host = current_url
                .host_str()
                .ok_or("Invalid stream host")?
                .trim_end_matches('.')
                .to_ascii_lowercase();
            let client = client_for_host(&session, &host).await?;
            let mut request = client.get(current_url.clone());
            if let Some(ref value) = session.referer {
                request = request.header(reqwest::header::REFERER, value);
            }
            if let Some(ref value) = session.origin {
                request = request.header(reqwest::header::ORIGIN, value);
            }
            if let Some(start) = range_start {
                request = request.header(
                    reqwest::header::RANGE,
                    match range_end {
                        Some(end) => format!("bytes={start}-{}", end - 1),
                        None => format!("bytes={start}-"),
                    },
                );
            }
            let resp = request
                .send()
                .await
                .map_err(|_| "Could not reach the stream server".to_string())?;
            if resp.status().is_redirection() {
                if hop == MAX_REDIRECTS {
                    return Err("Stream redirected too many times".into());
                }
                let location = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Stream redirect was missing a destination")?;
                current_url = resolve_redirect(&current_url, location)?;
                if let Some(redirect_host) = current_url.host_str() {
                    let _ = allow_host(&session, &redirect_host.trim_end_matches('.').to_ascii_lowercase());
                }
                continue;
            }
            final_response = Some(resp);
            break;
        }
        final_response.ok_or("Could not reach the stream server")?
    };

    if !response.status().is_success() {
        return Err(format!(
            "Stream server returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if range_start.is_some()
        && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        && response.status() != reqwest::StatusCode::OK
    {
        return Err("Stream server did not honor the requested byte range".into());
    }
    let returned_full = range_start.is_some() && response.status() == reqwest::StatusCode::OK;
    const MAX: usize = 16 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) {
        return Err("Stream segment is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the stream response".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX {
            return Err("Stream segment is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if returned_full {
        let start = range_start.unwrap_or(0) as usize;
        if start >= bytes.len() {
            return Err("Stream server returned fewer bytes than requested".into());
        }
        let end = range_end
            .map(|e| (e as usize).min(bytes.len()))
            .unwrap_or(bytes.len());
        bytes = bytes[start..end].to_vec();
    }
    if bytes.len() <= 2 * 1024 * 1024 {
        for discovered in extract_playlist_hosts(&current_url, &bytes) {
            let _ = allow_host(&session, &discovered);
        }
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn close_stream(
    webview: tauri::Webview,
    state: State<'_, StreamSessions>,
    session: String,
) -> Result<(), String> {
    require_main(&webview)?;
    state
        .0
        .lock()
        .map_err(|_| "Stream session unavailable")?
        .remove(&session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_local_and_special_addresses() {
        for ip in [
            "127.0.0.1",
            "10.2.3.4",
            "172.16.0.1",
            "192.168.1.2",
            "169.254.1.2",
            "100.64.0.1",
            "198.18.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001::1",
            "2002:7f00:1::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn restricts_url_shapes() {
        assert!(checked_url("https://cdn.example.org/master.m3u8").is_ok());
        for url in [
            "http://example.com",
            "https://localhost/a",
            "https://127.0.0.1/a",
            "https://user:pw@example.com",
            "https://example.com:8443/a",
            "file:///secret",
        ] {
            assert!(checked_url(url).is_err(), "accepted {url}");
        }
    }
    #[test]
    fn redirect_validation_allows_public_https_and_blocks_private() {
        let base = checked_url("https://cdn1.example.org/hls/master.m3u8").unwrap();
        assert_eq!(
            resolve_redirect(&base, "https://cdn2.example.net/seg/001.ts")
                .unwrap()
                .as_str(),
            "https://cdn2.example.net/seg/001.ts"
        );
        assert_eq!(
            resolve_redirect(&base, "/edge/seg/001.ts").unwrap().as_str(),
            "https://cdn1.example.org/edge/seg/001.ts"
        );
        assert!(resolve_redirect(&base, "http://cdn2.example.net/a.ts").is_err());
        assert!(resolve_redirect(&base, "https://127.0.0.1/secret").is_err());
        assert!(resolve_redirect(&base, "https://localhost/secret").is_err());
    }
    #[test]
    fn sanitizes_user_agent_header() {
        assert_eq!(
            sanitized_user_agent(Some("CustomAgent/1.0".into())),
            "CustomAgent/1.0"
        );
        assert_eq!(
            sanitized_user_agent(Some("Bad\r\nHeader: x".into())),
            DEFAULT_UA
        );
        assert_eq!(sanitized_user_agent(Some("   ".into())), DEFAULT_UA);
    }
    #[test]
    fn extracts_public_playlist_hosts_only() {
        let base = checked_url("https://master.example.org/hls/index.m3u8").unwrap();
        let m3u8 = br#"#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.net/k.bin"
#EXT-X-MEDIA:TYPE=AUDIO,URI="https://127.0.0.1/bad.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000
https://edge1.cdn.example.org/720p/index.m3u8
/relative/seg0.ts
http://insecure.example.com/seg1.ts
"#;
        let hosts = extract_playlist_hosts(&base, m3u8);
        assert!(hosts.contains(&"keys.example.net".to_string()));
        assert!(hosts.contains(&"edge1.cdn.example.org".to_string()));
        assert!(hosts.contains(&"master.example.org".to_string()));
        assert!(!hosts.iter().any(|h| h == "127.0.0.1" || h == "insecure.example.com"));
    }
}
