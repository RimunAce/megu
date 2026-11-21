//! Loopback-only HTTP stream proxy. The in-app player loads video from
//! `http://127.0.0.1:<port>/p/<session>/<percent-encoded upstream URL>`, so
//! hls.js and the <video> element speak plain HTTP with real Range requests
//! against a local server. Every upstream fetch still goes through the
//! stream_proxy guards: public HTTPS only, DNS pinned to public addresses,
//! and only hosts registered for that stream session. The listener binds to
//! 127.0.0.1, rejects non-loopback Host headers (DNS-rebinding guard), and
//! requires the per-player session id, which is an unguessable UUID created
//! by the renderer.
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::stream_proxy::{
    allow_host, checked_url, extract_playlist_hosts, is_host_allowed, resolve_public_addrs,
    resolve_redirect, Session, StreamSessions, MAX_REDIRECTS,
};

pub struct LocalProxy {
    pub port: u16,
    pub base: String,
    clients: Mutex<HashMap<(String, String), reqwest::Client>>,
}

impl LocalProxy {
    pub fn new(port: u16) -> Self {
        LocalProxy {
            port,
            base: format!("http://127.0.0.1:{port}"),
            clients: Mutex::new(HashMap::new()),
        }
    }
}

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_BODY: usize = 64 * 1024;
const MAX_SLICE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS: usize = 32;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_QUEUE_TIMEOUT: Duration = Duration::from_secs(15);
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const UPSTREAM_SEND_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_IO_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROXY_CLIENTS: usize = 64;

#[tauri::command]
pub fn stream_proxy_url(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app.state::<LocalProxy>().base.clone())
}

/// Start the loopback proxy on an ephemeral port. Returns the bound port.
pub fn start(app: tauri::AppHandle) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(e) => {
                log::error!("stream proxy listener failed: {e}");
                return;
            }
        };
        let conn_limit = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
        loop {
            match listener.accept().await {
                Ok((socket, _)) => {
                    let Ok(permit) = conn_limit.clone().try_acquire_owned() else {
                        drop(socket);
                        continue;
                    };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _permit = permit;
                        let proxy = app.state::<LocalProxy>();
                        let sessions = app.state::<StreamSessions>();
                        if let Err(e) = handle_connection(socket, proxy.inner(), sessions.inner()).await {
                            log::debug!("stream proxy connection closed: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::error!("stream proxy accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    Ok(port)
}

pub(crate) fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(crate) fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 3 > bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub(crate) fn local_stream_url(local_base: &str, session: &str, upstream: &str) -> String {
    format!("{local_base}/p/{session}/{}", percent_encode(upstream))
}

/// Rewrite every playlist reference (segments, variant playlists, keys, media
/// tracks) to an absolute loopback URL so the player only ever talks to the
/// local proxy.
pub(crate) fn rewrite_playlist(base: &url::Url, body: &[u8], local_base: &str, session: &str) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(body) else {
        return body.to_vec();
    };
    let mut out = String::with_capacity(text.len() + 256);
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let ending = &line[trimmed.len()..];
        if trimmed.is_empty() {
            out.push_str(line);
            continue;
        }
        if trimmed.starts_with('#') {
            let mut replaced = trimmed.to_string();
            let mut rest = &trimmed[1..];
            while let Some(idx) = rest.find("URI=\"") {
                let after = &rest[idx + 5..];
                let Some(end) = after.find('"') else { break };
                let raw = &after[..end];
                if let Ok(resolved) = base.join(raw) {
                    let local = local_stream_url(local_base, session, resolved.as_str());
                    replaced = replaced.replacen(&format!("URI=\"{raw}\""), &format!("URI=\"{local}\""), 1);
                }
                rest = &after[end + 1..];
            }
            out.push_str(&replaced);
            out.push_str(ending);
        } else if let Ok(resolved) = base.join(trimmed) {
            out.push_str(&local_stream_url(local_base, session, resolved.as_str()));
            out.push_str(ending);
        } else {
            out.push_str(line);
        }
    }
    out.into_bytes()
}

fn origin_allowed(origin: &str) -> bool {
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let loopback = host == "tauri.localhost"
        || host == "localhost"
        || host == "127.0.0.1"
        || host == "[::1]"
        || host == "::1";
    (parsed.scheme() == "http" || parsed.scheme() == "https")
        && loopback
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

fn host_header_allowed(host: &str, port: u16) -> bool {
    let host = host.trim().to_ascii_lowercase();
    host == format!("127.0.0.1:{port}")
        || host == format!("localhost:{port}")
        || host == "127.0.0.1"
        || host == "localhost"
        || host == format!("[::1]:{port}")
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        505 => "HTTP Version Not Supported",
        _ => "Status",
    }
}

fn cors_block(origin: Option<&str>, allow_cors: bool) -> String {
    if !allow_cors {
        return "Vary: Origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n".to_string();
    }
    let acao = origin.unwrap_or("*");
    format!(
        "Access-Control-Allow-Origin: {acao}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Accept, Content-Type\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\nAccess-Control-Max-Age: 600\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n"
    )
}

async fn write_head<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    extra: &[(String, String)],
    origin: Option<&str>,
) -> Result<(), String> {
    write_head_with_cors(stream, status, extra, origin, true).await
}

async fn write_head_with_cors<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    extra: &[(String, String)],
    origin: Option<&str>,
    allow_cors: bool,
) -> Result<(), String> {
    let mut out = format!("HTTP/1.1 {} {}\r\n", status, status_reason(status));
    for (name, value) in extra {
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    out.push_str(&cors_block(origin, allow_cors));
    out.push_str("\r\n");
    stream.write_all(out.as_bytes()).await.map_err(|e| e.to_string())
}

async fn respond_simple<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    message: &str,
    origin: Option<&str>,
) -> Result<(), String> {
    respond_simple_with_cors(stream, status, message, origin, true).await
}

async fn respond_simple_with_cors<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    message: &str,
    origin: Option<&str>,
    allow_cors: bool,
) -> Result<(), String> {
    let body = message.as_bytes();
    write_head_with_cors(
        stream,
        status,
        &[
            ("Content-Type".to_string(), "text/plain; charset=utf-8".to_string()),
            ("Content-Length".to_string(), body.len().to_string()),
        ],
        origin,
        allow_cors,
    )
    .await?;
    stream.write_all(body).await.map_err(|e| e.to_string())
}

pub(crate) fn parse_byte_range(value: &str) -> Option<(usize, Option<usize>)> {
    let rest = value.trim().strip_prefix("bytes=")?;
    if rest.contains(',') {
        return None;
    }
    let (start_str, end_str) = rest.split_once('-')?;
    if start_str.is_empty() {
        return None;
    }
    let start: usize = start_str.parse().ok()?;
    let end = if end_str.is_empty() {
        None
    } else {
        let parsed: usize = end_str.parse().ok()?;
        if parsed < start {
            return None;
        }
        Some(parsed)
    };
    Some((start, end))
}

pub(crate) fn slice_full_response_for_range<'a>(
    full: &'a [u8],
    range: (usize, Option<usize>),
) -> Result<(&'a [u8], String), &'static str> {
    let (start, end_opt) = range;
    if start >= full.len() {
        return Err("Requested range is not satisfiable");
    }
    let end = end_opt.map(|e| e.min(full.len() - 1)).unwrap_or(full.len() - 1);
    let content_range = format!("bytes {start}-{end}/{}", full.len());
    Ok((&full[start..=end], content_range))
}

async fn next_upstream_chunk(
    resp: &mut reqwest::Response,
    session: &Session,
) -> Result<Option<Vec<u8>>, String> {
    if session.is_cancelled() {
        return Err("Stream session closed".into());
    }
    tokio::select! {
        _ = session.cancel_notify.notified() => Err("Stream session closed".into()),
        res = tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, resp.chunk()) => {
            Ok(res
                .map_err(|_| "Stream body timed out".to_string())?
                .map_err(|_| "Could not read the stream response".to_string())?
                .map(|b| b.to_vec()))
        }
    }
}

async fn proxy_client(proxy: &LocalProxy, session: &Session, host: &str) -> Result<reqwest::Client, String> {
    let key = (host.to_string(), session.user_agent.clone());
    if let Some(client) = proxy
        .clients
        .lock()
        .ok()
        .and_then(|map| map.get(&key).cloned())
    {
        return Ok(client);
    }
    let addresses = resolve_public_addrs(host).await?;
    // No total request timeout here: ranged MP4 responses can stream for a
    // long time. The connect timeout still bounds dead hosts.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        .user_agent(&session.user_agent)
        .build()
        .map_err(|e| format!("Could not initialize stream: {e}"))?;
    let mut map = proxy.clients.lock().map_err(|_| "Stream session unavailable")?;
    if map.len() >= MAX_PROXY_CLIENTS {
        map.clear();
    }
    map.insert(key, client.clone());
    Ok(client)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn looks_like_playlist(content_type: &str, peek: &[u8]) -> bool {
    if content_type.contains("mpegurl") || content_type.contains("m3u8") {
        return true;
    }
    let sniffable = content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("octet-stream");
    if !sniffable {
        return false;
    }
    let trimmed = peek.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(peek);
    trimmed.starts_with(b"#EXTM3U")
}

pub(crate) async fn handle_connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    proxy: &LocalProxy,
    sessions: &StreamSessions,
) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let header_end = tokio::time::timeout(HEADER_READ_TIMEOUT, async {
        loop {
            if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                return Ok(pos);
            }
            if buf.len() >= MAX_HEADER_BYTES {
                return Err("Request headers too large");
            }
            let n = stream.read(&mut chunk).await.map_err(|_| "Header read failed")?;
            if n == 0 {
                return Err("Connection closed before headers");
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    })
    .await
    .map_err(|_| "Request header read timed out".to_string())?;
    let header_end = match header_end {
        Ok(pos) => pos,
        Err("Request headers too large") => {
            return respond_simple_with_cors(&mut stream, 400, "Request headers too large", None, false).await;
        }
        Err(msg) => return Err(msg.into()),
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut request_parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = request_parts.next().unwrap_or("").to_ascii_uppercase();
    let target = request_parts.next().unwrap_or("").to_string();
    let version = request_parts.next().unwrap_or("");
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return respond_simple_with_cors(&mut stream, 505, "Only HTTP/1.1 is supported", None, false).await;
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let header_count = |name: &str| headers.iter().filter(|(n, _)| n == name).count();
    if header_count("host") > 1 || header_count("origin") > 1 {
        return respond_simple_with_cors(&mut stream, 400, "Duplicate Host or Origin header", None, false).await;
    }
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    let origin = header("origin");
    if let Some(origin) = origin {
        if !origin_allowed(origin) {
            return respond_simple_with_cors(&mut stream, 403, "Origin is not allowed", None, false).await;
        }
    }
    if !host_header_allowed(header("host").unwrap_or(""), proxy.port) {
        return respond_simple_with_cors(&mut stream, 403, "Host is not allowed", None, false).await;
    }
    if method == "OPTIONS" {
        return write_head(&mut stream, 204, &[], origin).await;
    }
    if method != "GET" && method != "HEAD" {
        return respond_simple(&mut stream, 405, "Only GET and HEAD are supported", origin).await;
    }
    let head_only = method == "HEAD";

    let path = target.split(['?', '#']).next().unwrap_or("");
    let Some(rest) = path.strip_prefix("/p/") else {
        return respond_simple(&mut stream, 404, "Not found", origin).await;
    };
    let Some((session_id, encoded)) = rest.split_once('/') else {
        return respond_simple(&mut stream, 404, "Not found", origin).await;
    };
    if session_id.is_empty()
        || session_id.len() > 100
        || !session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return respond_simple(&mut stream, 400, "Invalid stream session", origin).await;
    }
    let Some(raw_url) = percent_decode(encoded) else {
        return respond_simple(&mut stream, 400, "Invalid stream URL encoding", origin).await;
    };
    let session = sessions
        .0
        .lock()
        .map_err(|_| "Stream session unavailable")?
        .get(session_id)
        .cloned();
    let Some(session) = session else {
        return respond_simple(&mut stream, 404, "Stream session expired", origin).await;
    };
    if session.is_cancelled() {
        return respond_simple(&mut stream, 404, "Stream session expired", origin).await;
    }
    let _session_permit = match tokio::time::timeout(SESSION_QUEUE_TIMEOUT, session.permits.acquire()).await {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => return respond_simple(&mut stream, 404, "Stream session expired", origin).await,
        Err(_) => return respond_simple(&mut stream, 502, "Stream request queue timed out", origin).await,
    };
    let Ok(mut current_url) = checked_url(&raw_url) else {
        return respond_simple(&mut stream, 400, "Only public HTTPS stream URLs are supported", origin).await;
    };
    let initial_host = current_url
        .host_str()
        .ok_or("Invalid stream host")?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !is_host_allowed(&session, &initial_host)? {
        return respond_simple(&mut stream, 403, "The stream requested an unregistered host; choose another player", origin).await;
    }
    let range = header("range").map(|v| v.to_string());

    let mut response = None;
    for hop in 0..=MAX_REDIRECTS {
        let host = current_url
            .host_str()
            .ok_or("Invalid stream host")?
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let client = proxy_client(proxy, &session, &host).await?;
        let mut request = client.request(
            if head_only { reqwest::Method::HEAD } else { reqwest::Method::GET },
            current_url.clone(),
        );
        if let Some(value) = &session.referer {
            request = request.header(reqwest::header::REFERER, value);
        }
        if let Some(value) = &session.origin {
            request = request.header(reqwest::header::ORIGIN, value);
        }
        if let Some(value) = &range {
            if value.len() <= 256 && value.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                request = request.header(reqwest::header::RANGE, value);
            }
        }
        let resp = tokio::time::timeout(UPSTREAM_SEND_TIMEOUT, request.send())
            .await
            .map_err(|_| "Stream server timed out".to_string())?
            .map_err(|_| "Could not reach the stream server".to_string())?;
        if resp.status().is_redirection() {
            if hop == MAX_REDIRECTS {
                return respond_simple(&mut stream, 502, "Stream redirected too many times", origin).await;
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("Stream redirect was missing a destination")?
                .to_string();
            current_url = match resolve_redirect(&current_url, &location) {
                Ok(next) => next,
                Err(e) => return respond_simple(&mut stream, 502, &e, origin).await,
            };
            if let Some(redirect_host) = current_url.host_str() {
                let _ = allow_host(&session, &redirect_host.trim_end_matches('.').to_ascii_lowercase());
            }
            continue;
        }
        response = Some(resp);
        break;
    }
    let mut resp = match response {
        Some(resp) => resp,
        None => return respond_simple(&mut stream, 502, "Could not reach the stream server", origin).await,
    };

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut relay: Vec<(String, String)> = Vec::new();
    for name in [
        reqwest::header::CONTENT_TYPE,
        reqwest::header::CONTENT_RANGE,
        reqwest::header::ACCEPT_RANGES,
        reqwest::header::ETAG,
        reqwest::header::LAST_MODIFIED,
        reqwest::header::CACHE_CONTROL,
    ] {
        if let Some(value) = resp.headers().get(&name).and_then(|v| v.to_str().ok()) {
            relay.push((name.as_str().to_string(), value.to_string()));
        }
    }
    let content_length: Option<u64> = resp.content_length();

    // Peek at the first bytes so playlists can be detected without buffering
    // binary segments.
    let mut peek: Vec<u8> = Vec::new();
    if status == 200 {
        if let Some(first) = next_upstream_chunk(&mut resp, &session).await? {
            peek.extend_from_slice(&first);
        }
    }

    if status == 200 && looks_like_playlist(&content_type, &peek) {
        // Allow hosts referenced by the playlist (segments, keys) before rewrite.
        let mut body = peek.clone();
        while body.len() < MAX_PLAYLIST_BYTES {
            match next_upstream_chunk(&mut resp, &session).await? {
                Some(chunk) => body.extend_from_slice(&chunk),
                None => break,
            }
        }
        if body.len() >= MAX_PLAYLIST_BYTES {
            return respond_simple(&mut stream, 502, "Stream playlist is too large", origin).await;
        }
        for discovered in extract_playlist_hosts(&current_url, &body) {
            let _ = allow_host(&session, &discovered);
        }
        let rewritten = rewrite_playlist(&current_url, &body, &proxy.base, session_id);
        let headers = vec![
            ("Content-Type".to_string(), "application/vnd.apple.mpegurl".to_string()),
            ("Content-Length".to_string(), rewritten.len().to_string()),
            ("Cache-Control".to_string(), "no-store".to_string()),
        ];
        write_head(&mut stream, 200, &headers, origin).await?;
        if !head_only {
            tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, stream.write_all(&rewritten))
                .await
                .map_err(|_| "Client write timed out".to_string())?
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // If the client requested a byte range (e.g. HLS BYTERANGE) and the CDN
    // ignored Range and returned 200 OK, slice the bounded body to 206.
    if status == 200 {
        if let Some(parsed_range) = range.as_deref().and_then(parse_byte_range) {
            if content_length.is_none_or(|n| n <= MAX_SLICE_BYTES as u64) {
                let mut full = peek.clone();
                let mut overflowed = false;
                while let Some(chunk) = next_upstream_chunk(&mut resp, &session).await? {
                    if full.len().saturating_add(chunk.len()) > MAX_SLICE_BYTES {
                        overflowed = true;
                        break;
                    }
                    full.extend_from_slice(&chunk);
                }
                if !overflowed {
                    match slice_full_response_for_range(&full, parsed_range) {
                        Ok((sliced, content_range)) => {
                            let mut headers = relay.clone();
                            headers.retain(|(name, _)| {
                                name != "content-length" && name != "transfer-encoding" && name != "content-range"
                            });
                            headers.push(("Content-Range".to_string(), content_range));
                            headers.push(("Content-Length".to_string(), sliced.len().to_string()));
                            write_head(&mut stream, 206, &headers, origin).await?;
                            if !head_only {
                                tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, stream.write_all(sliced))
                                    .await
                                    .map_err(|_| "Client write timed out".to_string())?
                                    .map_err(|e| e.to_string())?;
                            }
                            return Ok(());
                        }
                        Err(msg) => {
                            return respond_simple(&mut stream, 416, msg, origin).await;
                        }
                    }
                }
            }
        }
    }

    if status < 200 || status >= 300 {
        let mut body = peek.clone();
        while body.len() < MAX_ERROR_BODY {
            match next_upstream_chunk(&mut resp, &session).await? {
                Some(chunk) => body.extend_from_slice(&chunk),
                None => break,
            }
        }
        let mut headers = relay.clone();
        headers.retain(|(name, _)| name != "content-length");
        headers.push(("Content-Length".to_string(), body.len().to_string()));
        write_head(&mut stream, status, &headers, origin).await?;
        if !head_only {
            tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, stream.write_all(&body))
                .await
                .map_err(|_| "Client write timed out".to_string())?
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Binary passthrough: relay status (200/206), range headers and body bytes
    // as they arrive, so large MP4 range responses stream without buffering.
    let mut headers = relay.clone();
    headers.retain(|(name, _)| name != "content-length" && name != "transfer-encoding");
    let chunked = content_length.is_none();
    if let Some(len) = content_length {
        headers.push(("Content-Length".to_string(), len.to_string()));
    } else {
        headers.push(("Transfer-Encoding".to_string(), "chunked".to_string()));
    }
    write_head(&mut stream, status, &headers, origin).await?;
    if head_only {
        return Ok(());
    }
    if !peek.is_empty() {
        write_body_chunk(&mut stream, &peek, chunked).await?;
    }
    while let Some(chunk) = next_upstream_chunk(&mut resp, &session).await? {
        if !chunk.is_empty() {
            write_body_chunk(&mut stream, &chunk, chunked).await?;
        }
    }
    if chunked {
        tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, stream.write_all(b"0\r\n\r\n"))
            .await
            .map_err(|_| "Client write timed out".to_string())?
            .map_err(|e| e.to_string())?;
    }
    tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, stream.flush())
        .await
        .map_err(|_| "Client flush timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn write_body_chunk<S: AsyncWrite + Unpin>(
    stream: &mut S,
    data: &[u8],
    chunked: bool,
) -> Result<(), String> {
    tokio::time::timeout(BODY_IO_IDLE_TIMEOUT, async {
        if chunked {
            stream
                .write_all(format!("{:x}\r\n", data.len()).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            stream.write_all(data).await.map_err(|e| e.to_string())?;
            stream.write_all(b"\r\n").await.map_err(|e| e.to_string())?;
        } else {
            stream.write_all(data).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "Client write timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    fn test_session(hosts: &[&str]) -> Session {
        Session {
            referer: None,
            origin: None,
            user_agent: crate::stream_proxy::DEFAULT_UA.to_string(),
            permits: Arc::new(tokio::sync::Semaphore::new(6)),
            allowed_hosts: Arc::new(Mutex::new(
                hosts.iter().map(|h| h.to_string()).collect::<HashSet<_>>(),
            )),
            clients: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cancel_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    #[test]
    fn slices_full_200_response_into_exact_206_byte_range() {
        let payload = b"0123456789abcdef";
        let range = parse_byte_range("bytes=4-9").expect("valid range");
        let (sliced, content_range) = slice_full_response_for_range(payload, range).expect("slice");
        assert_eq!(sliced, b"456789");
        assert_eq!(content_range, "bytes 4-9/16");

        let open_range = parse_byte_range("bytes=12-").expect("valid open range");
        let (sliced2, content_range2) = slice_full_response_for_range(payload, open_range).expect("slice");
        assert_eq!(sliced2, b"cdef");
        assert_eq!(content_range2, "bytes 12-15/16");

        let oob = parse_byte_range("bytes=20-25").expect("valid syntax");
        assert!(slice_full_response_for_range(payload, oob).is_err());
    }

    #[test]
    fn percent_codec_roundtrips_urls() {
        for url in [
            "https://cdn.example.org/hls/master.m3u8?token=a b&x=1",
            "https://edge.example.net/seg/001.ts#frag",
            "https://example.com/",
        ] {
            assert_eq!(percent_decode(&percent_encode(url)).as_deref(), Some(url));
        }
        assert_eq!(percent_decode("%2F%3A%3F"), Some("/:?".to_string()));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%2"), None);
    }

    #[test]
    fn local_stream_url_embeds_encoded_upstream() {
        let url = local_stream_url("http://127.0.0.1:4321", "abc-123", "https://cdn.example.org/a.m3u8?x=1/2");
        assert_eq!(
            url,
            "http://127.0.0.1:4321/p/abc-123/https%3A%2F%2Fcdn.example.org%2Fa.m3u8%3Fx%3D1%2F2"
        );
    }

    #[test]
    fn rewrites_segments_keys_and_variants_to_loopback() {
        let base = url::Url::parse("https://cdn.example.org/hls/master.m3u8").unwrap();
        let body = br#"#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.net/k.bin",IV=0x1
#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/en.m3u8",LANGUAGE="en"
#EXT-X-STREAM-INF:BANDWIDTH=1280000
720p/index.m3u8
https://edge.example.net/1080p/index.m3u8
"#;
        let out = String::from_utf8(rewrite_playlist(&base, body, "http://127.0.0.1:9000", "sess-1")).unwrap();
        assert!(out.contains("URI=\"http://127.0.0.1:9000/p/sess-1/https%3A%2F%2Fkeys.example.net%2Fk.bin\""));
        assert!(out.contains("URI=\"http://127.0.0.1:9000/p/sess-1/https%3A%2F%2Fcdn.example.org%2Fhls%2Faudio%2Fen.m3u8\""));
        assert!(out.contains("http://127.0.0.1:9000/p/sess-1/https%3A%2F%2Fcdn.example.org%2Fhls%2F720p%2Findex.m3u8"));
        assert!(out.contains("http://127.0.0.1:9000/p/sess-1/https%3A%2F%2Fedge.example.net%2F1080p%2Findex.m3u8"));
        assert!(out.starts_with("#EXTM3U"));
        assert!(!out.contains("https://cdn.example.org/hls/720p"));
    }

    #[test]
    fn rewrites_media_playlist_segment_lines() {
        let base = url::Url::parse("https://cdn.example.org/hls/720p/index.m3u8").unwrap();
        let body = b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\n../seg1.ts\n#EXT-X-ENDLIST\n";
        let out = String::from_utf8(rewrite_playlist(&base, body, "http://127.0.0.1:9000", "s")).unwrap();
        assert!(out.contains("http://127.0.0.1:9000/p/s/https%3A%2F%2Fcdn.example.org%2Fhls%2F720p%2Fseg0.ts"));
        assert!(out.contains("http://127.0.0.1:9000/p/s/https%3A%2F%2Fcdn.example.org%2Fhls%2Fseg1.ts"));
        assert!(out.contains("#EXT-X-ENDLIST"));
    }

    #[test]
    fn playlist_detection_uses_content_type_or_bom_sniff() {
        assert!(looks_like_playlist("application/vnd.apple.mpegurl", b""));
        assert!(looks_like_playlist("application/octet-stream", b"\xEF\xBB\xBF#EXTM3U\n"));
        assert!(looks_like_playlist("text/plain", b"#EXTM3U\n"));
        assert!(!looks_like_playlist("video/mp2t", b"#EXTM3U"));
        assert!(!looks_like_playlist("video/mp4", b"\x00\x00\x00\x18ftyp"));
    }

    #[test]
    fn origin_and_host_guards() {
        assert!(origin_allowed("http://tauri.localhost"));
        assert!(origin_allowed("https://tauri.localhost"));
        assert!(origin_allowed("http://127.0.0.1:1420"));
        assert!(!origin_allowed("https://evil.example.com"));
        assert!(!origin_allowed("https://tauri.localhost.evil.com"));
        assert!(!origin_allowed("not a url"));
        assert!(host_header_allowed("127.0.0.1:4321", 4321));
        assert!(host_header_allowed("localhost:4321", 4321));
        assert!(!host_header_allowed("evil.example.com", 4321));
        assert!(!host_header_allowed("127.0.0.1:9999", 4321));
    }

    /// Drive one request through handle_connection over an in-memory socket.
    /// The request is written into the duplex buffer first, then the handler
    /// runs to completion, then the response is read back.
    async fn roundtrip(proxy: &LocalProxy, sessions: &StreamSessions, request: &str) -> String {
        let (mut client, server) = tokio::io::duplex(512 * 1024);
        client.write_all(request.as_bytes()).await.unwrap();
        handle_connection(server, proxy, sessions).await.unwrap();
        let mut buf = Vec::new();
        client.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).to_string()
    }

    #[tokio::test]
    async fn serves_404_for_unknown_session_and_adds_cors() {
        let proxy = LocalProxy::new(4321);
        let sessions = StreamSessions::default();
        let text = roundtrip(
            &proxy,
            &sessions,
            "GET /p/nope/https%3A%2F%2Fexample.com%2F HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\n\r\n",
        )
        .await;
        assert!(text.starts_with("HTTP/1.1 404"), "{text}");
        assert!(text.contains("Access-Control-Allow-Origin: http://tauri.localhost"), "{text}");
    }

    #[tokio::test]
    async fn rejects_non_loopback_host_header() {
        let proxy = LocalProxy::new(4321);
        let sessions = StreamSessions::default();
        let text = roundtrip(
            &proxy,
            &sessions,
            "GET /p/s/https%3A%2F%2Fexample.com%2F HTTP/1.1\r\nHost: evil.example.com\r\n\r\n",
        )
        .await;
        assert!(text.starts_with("HTTP/1.1 403"), "{text}");
    }

    #[tokio::test]
    async fn answers_cors_preflight() {
        let proxy = LocalProxy::new(4321);
        let sessions = StreamSessions::default();
        let text = roundtrip(
            &proxy,
            &sessions,
            "OPTIONS /p/s/x HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\n\r\n",
        )
        .await;
        assert!(text.starts_with("HTTP/1.1 204"), "{text}");
        assert!(text.contains("Access-Control-Allow-Origin: http://tauri.localhost"), "{text}");
        assert!(text.contains("Access-Control-Allow-Headers: Range"), "{text}");
    }

    #[tokio::test]
    async fn blocks_unregistered_upstream_host_for_known_session() {
        let proxy = LocalProxy::new(4321);
        let sessions = StreamSessions::default();
        sessions
            .0
            .lock()
            .unwrap()
            .insert("sess".to_string(), test_session(&["cdn.example.org"]));
        let text = roundtrip(
            &proxy,
            &sessions,
            "GET /p/sess/https%3A%2F%2Fother.example.net%2Fx HTTP/1.1\r\nHost: 127.0.0.1:4321\r\n\r\n",
        )
        .await;
        assert!(text.starts_with("HTTP/1.1 403"), "{text}");
    }

    #[tokio::test]
    async fn blocks_non_https_upstream() {
        let proxy = LocalProxy::new(4321);
        let sessions = StreamSessions::default();
        sessions
            .0
            .lock()
            .unwrap()
            .insert("sess".to_string(), test_session(&["example.com"]));
        let text = roundtrip(
            &proxy,
            &sessions,
            "GET /p/sess/http%3A%2F%2Fexample.com%2F HTTP/1.1\r\nHost: 127.0.0.1:4321\r\n\r\n",
        )
        .await;
        assert!(text.starts_with("HTTP/1.1 400"), "{text}");
    }

    /// End-to-end over a real socket: register a session for a public host and
    /// fetch through the loopback handler exactly like the player does, with a
    /// Range request. Needs network access, so run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "requires network access to example.com"]
    async fn live_loopback_fetch_end_to_end() {
        let sessions = StreamSessions::default();
        let host = "example.com";
        let addresses = resolve_public_addrs(host).await.unwrap();
        let client =
            crate::stream_proxy::build_pinned_client(host, &addresses, crate::stream_proxy::DEFAULT_UA).unwrap();
        let mut allowed = HashSet::new();
        allowed.insert(host.to_string());
        let mut clients = HashMap::new();
        clients.insert(host.to_string(), client);
        sessions.0.lock().unwrap().insert(
            "live".to_string(),
            Session {
                referer: None,
                origin: None,
                user_agent: crate::stream_proxy::DEFAULT_UA.to_string(),
                permits: Arc::new(tokio::sync::Semaphore::new(6)),
                allowed_hosts: Arc::new(Mutex::new(allowed)),
                clients: Arc::new(Mutex::new(clients)),
                cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                cancel_notify: Arc::new(tokio::sync::Notify::new()),
            },
        );
        let proxy = LocalProxy::new(4321);
        let path = local_stream_url(&proxy.base, "live", "https://example.com/")
            .trim_start_matches(&proxy.base)
            .to_string();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\nRange: bytes=0-99\r\n\r\n"
        );
        let text = roundtrip(&proxy, &sessions, &request).await;
        assert!(
            text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.1 206"),
            "{text}"
        );
        assert!(text.contains("Access-Control-Allow-Origin: http://tauri.localhost"), "{text}");
        assert!(text.contains("Example Domain") || text.contains("Content-Range"), "{text}");
    }

    /// Full player path against a real public HLS stream (Mux test stream):
    /// master playlist comes back rewritten to loopback URLs, and a rewritten
    /// variant URL fetches through the proxy again. Run with
    /// `cargo test --lib -- --ignored`.
    #[tokio::test]
    #[ignore = "requires network access to test-streams.mux.dev"]
    async fn live_hls_playlist_rewrite_end_to_end() {
        let host = "test-streams.mux.dev";
        let sessions = StreamSessions::default();
        sessions.0.lock().unwrap().insert(
            "hls".to_string(),
            test_session(&[host]),
        );
        let proxy = LocalProxy::new(4321);
        let master = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
        let path = local_stream_url(&proxy.base, "hls", master)
            .trim_start_matches(&proxy.base)
            .to_string();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\n\r\n");
        let text = roundtrip(&proxy, &sessions, &request).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("Content-Type: application/vnd.apple.mpegurl"), "{text}");
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(body.starts_with("#EXTM3U"), "{body}");
        assert!(
            !body.lines().any(|l| l.starts_with("https://") || l.contains("URI=\"https://")),
            "playlist not rewritten: {body}"
        );
        assert!(body.contains("http://127.0.0.1:4321/p/hls/"), "{body}");
        let variant = body
            .lines()
            .find(|line| !line.starts_with('#') && !line.is_empty())
            .expect("playlist has a variant line");
        let variant_path = variant.trim_start_matches(&proxy.base).to_string();
        let request = format!("GET {variant_path} HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\n\r\n");
        let text = roundtrip(&proxy, &sessions, &request).await;
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        let media = text.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(media.contains("#EXTINF"), "variant playlist not returned: {media}");
        assert!(
            !media.lines().any(|l| l.starts_with("https://") || l.contains("URI=\"https://")),
            "media playlist not rewritten: {media}"
        );
        // A rewritten segment URL must also pass through with a range request.
        let segment = media
            .lines()
            .find(|line| !line.starts_with('#') && !line.is_empty())
            .expect("media playlist has a segment line");
        let segment_path = segment.trim_start_matches(&proxy.base).to_string();
        let request = format!("GET {segment_path} HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nOrigin: http://tauri.localhost\r\nRange: bytes=0-1023\r\n\r\n");
        let text = roundtrip(&proxy, &sessions, &request).await;
        assert!(
            text.starts_with("HTTP/1.1 206") || text.starts_with("HTTP/1.1 200"),
            "{text}"
        );
    }
}
