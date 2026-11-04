//! AniList OAuth via loopback redirect + token storage in Windows Credential Manager.
//!
//! Flow:
//! 1. User creates an AniList OAuth app (https://anilist.co/settings/developer) with
//!    Redirect URI = `http://127.0.0.1:9420/callback` and pastes the Client ID
//!    and Client Secret into the app's login screen.
//! 2. We open the browser to AniList's authorize page, listen on 127.0.0.1:9420,
//!    capture the `code`, exchange it for an access token, and store the token
//!    in the OS credential store (never in plaintext files).

use serde::Serialize;
use std::{collections::{HashMap, HashSet}, sync::Mutex, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SERVICE: &str = "megu";
// Read only for upgrades from the old app; new credentials use MEGU.
const LEGACY_SERVICE: &str = "croutonflix";
const TOKEN_ACCOUNT: &str = "anilist_access_token";
const SECRET_ACCOUNT: &str = "anilist_client_secret";
const REDIRECT_URI: &str = "http://127.0.0.1:9420/callback";
const BIND_ADDR: &str = "127.0.0.1:9420";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct OAuthAttempts(Mutex<AttemptState>);

#[derive(Default)]
struct AttemptState {
    active: HashMap<String, (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>,
    cancelled: HashSet<String>,
}

#[tauri::command]
pub async fn cancel_oauth(attempt_id: String, attempts: tauri::State<'_, OAuthAttempts>) -> Result<(), String> {
    let completion = {
        let mut state = attempts.0.lock().map_err(|_| "Login state unavailable")?;
        if let Some((cancel, done)) = state.active.remove(&attempt_id) {
            let _ = cancel.send(());
            Some(done)
        } else {
            state.cancelled.insert(attempt_id);
            None
        }
    };
    if let Some(done) = completion { let _ = done.await; }
    Ok(())
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("credential store: {e}"))
}

pub fn save_token(token: &str, client_secret: Option<&str>) -> Result<(), String> {
    entry(TOKEN_ACCOUNT)?.set_password(token).map_err(|e| format!("store token: {e}"))?;
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            entry(SECRET_ACCOUNT)?.set_password(secret).map_err(|e| format!("store secret: {e}"))?;
        }
    }
    Ok(())
}

pub fn get_token() -> Result<Option<String>, String> {
    let e = entry(TOKEN_ACCOUNT)?;
    match e.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Err(keyring::Error::NoEntry) | Ok(_) => {
            let legacy = keyring::Entry::new(LEGACY_SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("credential store: {e}"))?;
            match legacy.get_password() {
                Ok(token) if !token.is_empty() => {
                    e.set_password(&token).map_err(|e| format!("migrate token: {e}"))?;
                    Ok(Some(token))
                }
                Err(keyring::Error::NoEntry) | Ok(_) => Ok(None),
                Err(e) => Err(format!("read previous token: {e}")),
            }
        },
        Err(e) => Err(format!("read token: {e}")),
    }
}

pub fn delete_token() -> Result<(), String> {
    let _ = entry(TOKEN_ACCOUNT).map(|e| e.delete_credential());
    let _ = entry(SECRET_ACCOUNT).map(|e| e.delete_credential());
    for account in [TOKEN_ACCOUNT, SECRET_ACCOUNT] {
        if let Ok(legacy) = keyring::Entry::new(LEGACY_SERVICE, account) { let _ = legacy.delete_credential(); }
    }
    Ok(())
}

fn random_hex(bytes: usize) -> String {
    let values: Vec<u8> = (0..bytes).map(|_| rand::random::<u8>()).collect();
    values.iter().map(|b| format!("{b:02x}")).collect()
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[derive(Debug, Serialize)]
pub struct OAuthResult {
    pub access_token: String,
}

/// Start the OAuth login flow. Opens the browser, waits (up to 3 min) for the
/// loopback callback, exchanges the code, and stores the token.
#[tauri::command]
pub async fn start_oauth(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
    attempt_id: String,
    attempts: tauri::State<'_, OAuthAttempts>,
) -> Result<OAuthResult, String> {
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    {
        let mut state = attempts.0.lock().map_err(|_| "Login state unavailable")?;
        if state.cancelled.remove(&attempt_id) { return Err("Login cancelled".into()); }
        if !state.active.is_empty() { return Err("Another login is already in progress".into()); }
        state.active.insert(attempt_id.clone(), (cancel_tx, done_rx));
    }
    let result = tokio::select! {
        _ = cancel_rx => Err("Login cancelled".into()),
        result = oauth_flow(app, client_id, client_secret) => result,
    };
    if let Ok(mut state) = attempts.0.lock() { state.active.remove(&attempt_id); }
    let _ = done_tx.send(());
    result
}

async fn oauth_flow(app: tauri::AppHandle, client_id: String, client_secret: Option<String>) -> Result<OAuthResult, String> {
    if client_id.trim().is_empty() {
        return Err("Client ID is required. Create an app at anilist.co/settings/developer.".into());
    }
    if client_secret.as_deref().unwrap_or("").trim().is_empty() { return Err("Client secret is required for AniList login.".into()); }

    let state = random_hex(16);
    let authorize_url = format!(
        "https://anilist.co/api/v2/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&state={}",
        enc(client_id.trim()),
        enc(REDIRECT_URI),
        state
    );

    // Bind the loopback listener BEFORE opening the browser so we can never
    // miss the callback.
    let listener = TcpListener::bind(BIND_ADDR)
        .await
        .map_err(|e| format!("Could not listen on {BIND_ADDR} ({e}). Is another app using port 9420?"))?;

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&authorize_url, None::<&str>)
            .map_err(|e| format!("Could not open browser: {e}"))?;
    }

    let code = tokio::time::timeout(OAUTH_TIMEOUT, accept_code(&listener, &state))
        .await
        .map_err(|_| "Login timed out (3 minutes). Please try again.".to_string())??;

    let token = exchange_code(&client_id, client_secret.as_deref(), &code).await?;
    save_token(&token, client_secret.as_deref())?;
    Ok(OAuthResult { access_token: token })
}

/// Accept connections until we get one to /callback with a matching state.
async fn accept_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| format!("accept: {e}"))?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
        let request = String::from_utf8_lossy(&buf[..n]).into_owned();
        let first_line = request.lines().next().unwrap_or("");
        // GET /callback?code=...&state=... HTTP/1.1
        let path = first_line.split_whitespace().nth(1).unwrap_or("");
        if path.split('?').next() != Some("/callback") {
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        }
        let query = path.split('?').nth(1).unwrap_or("");
        let params: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
        let got_state = params.get("state").map(String::as_str).unwrap_or("");
        if got_state != expected_state {
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await;
            return Err("Login state mismatch (possible CSRF). Please try again.".into());
        }
        if let Some(err) = params.get("error") {
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n").await;
            return Err(format!("AniList denied the login: {err}"));
        }
        let code = params.get("code").cloned().unwrap_or_default();
        if code.is_empty() {
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await;
            return Err("No authorization code received. Please try again.".into());
        }
        let body = "<html><body style='font-family:sans-serif;text-align:center;padding-top:4rem'><h2>Authorization received</h2><p>You can close this tab and return to the app to finish signing in.</p></body></html>";
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        let _ = socket.write_all(response.as_bytes()).await;
        return Ok(code);
    }
}

async fn exchange_code(client_id: &str, client_secret: Option<&str>, code: &str) -> Result<String, String> {
    let mut body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}",
        enc(code),
        enc(REDIRECT_URI),
        enc(client_id.trim())
    );
    if let Some(secret) = client_secret {
        let secret = secret.trim();
        if !secret.is_empty() {
            body.push_str(&format!("&client_secret={}", enc(secret)));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post("https://anilist.co/api/v2/oauth/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Token request failed: {e}"))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Bad token response: {e}"))?;
    if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
        return Err(format!("AniList rejected the login: {msg}. Check your Client ID/secret and redirect URI."));
    }
    json.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "No access token in AniList response.".into())
}
