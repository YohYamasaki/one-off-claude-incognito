use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use tauri::{AppHandle, Emitter};
use tempfile::TempDir;

const INCOGNITO_SYSTEM_PROMPT: &str = "You are a friendly, helpful chat assistant in an ephemeral incognito chat window. Nothing in this conversation is saved or remembered after the window closes.\n\nGuidelines:\n- The only tools available in this session are WebSearch and WebFetch — use them freely when looking something up would help. No file-system, shell, or memory tools are available; don't attempt them.\n- Linking to and quoting URLs in your reply is fine and encouraged. Markdown links render normally.\n- Do NOT output XML tool-call syntax such as <function_calls>, <invoke>, or <parameter>. Never wrap your response in such tags.\n- Respond in natural conversational text or Markdown. Be direct and useful.";

/// Locate the `claude` binary. GUI apps on macOS don't inherit the shell PATH,
/// so we have to look in common install locations and fall back to asking a
/// login shell.
fn claude_path() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        if let Some(home) = dirs::home_dir() {
            for candidate in [
                home.join(".local").join("bin").join("claude"),
                home.join(".claude").join("local").join("claude"),
            ] {
                if candidate.exists() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
        for candidate in [
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        if let Ok(output) = Command::new("/bin/zsh")
            .args(["-l", "-c", "command -v claude"])
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return path;
            }
        }
        "claude".to_string()
    })
}

pub struct ChatSession {
    child: Child,
    stdin: ChildStdin,
    tempdir: TempDir,
    pub model: String,
    pub effort: String,
}

impl ChatSession {
    pub fn start(
        app: &AppHandle,
        window_label: String,
        model: &str,
        effort: &str,
    ) -> std::io::Result<Self> {
        // Last line of defense against CLI-flag injection: every
        // caller is supposed to canonicalize first, but a future
        // refactor could forget and ship a `claude --model
        // --allowedTools Bash` bug into production. Run canonicalize
        // here too — it's idempotent on already-safe inputs.
        let model = crate::settings::canonicalize_model(model);
        let effort = crate::settings::canonicalize_effort(effort);

        let tempdir = tempfile::Builder::new()
            .prefix("one-off-claude-incognito-")
            .tempdir()?;

        let mut args: Vec<String> = vec![
            "--print".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--include-partial-messages".into(),
            "--no-session-persistence".into(),
            // Web-only tool surface: WebSearch + WebFetch are useful
            // for "look this up" chats, while Bash / Read / Write /
            // Edit / Glob / Grep all touch the user's filesystem (or
            // worse, shell) and have no business in an ephemeral chat
            // window. The Rust-side scheme allowlist on
            // open_external_url, plus the WebView's CSP and link-click
            // interceptor, keep network-derived URLs from doing
            // anything dangerous if the user clicks them.
            "--tools".into(),
            "WebSearch,WebFetch".into(),
            // `--tools` makes them AVAILABLE; `--allowed-tools`
            // auto-approves them so claude doesn't try to surface a
            // permission dialog (we're in --print mode and would
            // deadlock waiting for stdin). Without this, claude
            // replies as if the tools weren't granted — telling the
            // user "if you give me WebSearch/WebFetch permission I
            // could look that up", which defeats the point.
            "--allowed-tools".into(),
            "WebSearch WebFetch".into(),
            "--model".into(),
            model.clone(),
            "--append-system-prompt".into(),
            INCOGNITO_SYSTEM_PROMPT.into(),
        ];
        if !effort.is_empty() && effort != "default" {
            args.push("--effort".into());
            args.push(effort.clone());
        }

        let mut child = Command::new(claude_path())
            .args(&args)
            .current_dir(tempdir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no stdout"))?;

        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    eprintln!("[claude stderr] {}", line);
                }
            });
        }

        // Route claude output to this session's window only.
        //
        // Subtle Tauri behaviour: `WebviewWindow::emit` is the default
        // Emitter trait method that internally calls `manager.emit`,
        // which BROADCASTS to every webview — it doesn't filter by
        // the receiver's label. Using it here caused window A's
        // claude reply to also fire window B's listener for the same
        // event name, mixing conversations across panes.
        //
        // `emit_to(label, …)` builds an EventTarget::AnyLabel and the
        // manager runs `filter_target` against each listener, only
        // matching ones whose target carries the same label. Combined
        // with the frontend registering its listener with target
        // `{kind:'WebviewWindow', label}` (see chat.ts), each window
        // receives its own deltas and nothing else.
        let app_for_thread = app.clone();
        let label_for_thread = window_label.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let _ = app_for_thread.emit_to(label_for_thread.as_str(), "claude-event", line);
            }
            let _ = app_for_thread.emit_to(label_for_thread.as_str(), "claude-end", ());
        });

        Ok(Self {
            child,
            stdin,
            tempdir,
            model,
            effort,
        })
    }

    pub fn send(&mut self, text: &str) -> std::io::Result<()> {
        let payload = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": text,
            }
        });
        writeln!(self.stdin, "{}", payload)?;
        self.stdin.flush()?;
        Ok(())
    }
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();

        // Fast path for the normal-close case. The startup sweep in
        // crate::cleanup picks up anything this misses (crash, hard
        // kill, encoded-path mismatch with what claude actually wrote).
        if let Some(home) = dirs::home_dir() {
            if let Ok(canonical) = self.tempdir.path().canonicalize() {
                if let Some(encoded) = crate::cleanup::encode_path(&canonical) {
                    let project_dir = home.join(".claude").join("projects").join(encoded);
                    let _ = std::fs::remove_dir_all(&project_dir);
                }
            }
        }
    }
}
