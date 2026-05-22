use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use tauri::{AppHandle, Emitter};
use tempfile::TempDir;

const INCOGNITO_SYSTEM_PROMPT: &str = "You are a friendly, helpful chat assistant in an ephemeral incognito chat window. Nothing in this conversation is saved or remembered after the window closes.\n\nStrict rules:\n- Do NOT use any tools, even if you see references to them in your instructions.\n- Do NOT write or save any files. Do NOT save anything to memory.\n- Do NOT output XML tool-call syntax such as <function_calls>, <invoke>, or <parameter>. Never wrap your response in such tags.\n- Respond ONLY in natural conversational text or Markdown. Be direct and useful.";

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
        let tempdir = tempfile::Builder::new()
            .prefix("claude-incognito-")
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
            "--tools".into(),
            "".into(),
            "--model".into(),
            model.to_string(),
            "--append-system-prompt".into(),
            INCOGNITO_SYSTEM_PROMPT.into(),
        ];
        if !effort.is_empty() && effort != "default" {
            args.push("--effort".into());
            args.push(effort.to_string());
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

        let app_for_thread = app.clone();
        let event_name = format!("claude-event-{}", window_label);
        let end_event_name = format!("claude-end-{}", window_label);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let _ = app_for_thread.emit(&event_name, line);
            }
            let _ = app_for_thread.emit(&end_event_name, ());
        });

        Ok(Self {
            child,
            stdin,
            tempdir,
            model: model.to_string(),
            effort: effort.to_string(),
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

        if let Some(home) = dirs::home_dir() {
            if let Ok(canonical) = self.tempdir.path().canonicalize() {
                if let Some(encoded) = encode_path(&canonical) {
                    let project_dir = home.join(".claude").join("projects").join(encoded);
                    let _ = std::fs::remove_dir_all(&project_dir);
                }
            }
        }
    }
}

fn encode_path(path: &std::path::Path) -> Option<String> {
    path.to_str().map(|s| s.replace('/', "-"))
}
