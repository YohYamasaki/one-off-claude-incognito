use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub hotkey: HotkeyConfig,
    pub model: String,
    pub effort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HotkeyConfig {
    pub modifiers: Vec<String>,
    pub key: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            modifiers: vec!["super".into(), "shift".into()],
            key: "KeyC".into(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: HotkeyConfig::default(),
            model: "claude-sonnet-4-6".into(),
            effort: "low".into(),
        }
    }
}

pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
pub const DEFAULT_EFFORT: &str = "low";
pub const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "max"];

/// Returns true iff `s` is a syntactically safe model identifier.
///
/// "Safe" here means: contains no CLI-flag prefix and only the ASCII
/// alphanumerics / dashes / dots / underscores that real model names
/// use. We don't validate that the model EXISTS — claude itself reports
/// unknown models — but we DO refuse anything that could be parsed by
/// claude's argv as additional flags. Without this, a string like
/// `--allowedTools Bash` would be quietly accepted via the IPC layer
/// (e.g. after a sanitizer bypass in the chat WebView) and re-emerge
/// as `claude --model --allowedTools Bash …`, switching tools back on
/// inside the supposedly incognito subprocess.
pub fn is_valid_model(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

/// Returns true iff `s` is one of the known effort tiers we pass to
/// `claude --effort`. Anything else is rejected so an attacker can't
/// inject CLI flags through this field (see is_valid_model for the
/// fuller threat).
pub fn is_valid_effort(s: &str) -> bool {
    VALID_EFFORTS.contains(&s)
}

/// Migrate legacy effort values and fall back to the default tier if
/// the input is invalid. Old settings used "default" to mean
/// "don't pass --effort"; the UI now matches Claude Code's set of
/// {low, medium, high, max}, with "low" as the new entry-level.
pub fn canonicalize_effort(s: &str) -> String {
    let canonical = match s {
        "default" | "" => DEFAULT_EFFORT,
        other => other,
    };
    if is_valid_effort(canonical) {
        canonical.into()
    } else {
        DEFAULT_EFFORT.into()
    }
}

/// Map legacy short aliases (sonnet/opus/haiku) to specific versioned
/// names and fall back to the default model if the input doesn't look
/// like a valid model identifier (see is_valid_model).
pub fn canonicalize_model(s: &str) -> String {
    let canonical = match s {
        "sonnet" => "claude-sonnet-4-6",
        "haiku" => "claude-haiku-4-5",
        "opus" => "claude-opus-4-7",
        other => other,
    };
    if is_valid_model(canonical) {
        canonical.into()
    } else {
        DEFAULT_MODEL.into()
    }
}

impl Settings {
    /// Build a Shortcut from the configured hotkey, or return None if
    /// the config is invalid.
    ///
    /// Invariants enforced here so every code path going through
    /// to_shortcut() sees the same rules:
    ///   - The modifiers list isn't empty.
    ///   - At least one "anchor" modifier (Cmd, Ctrl, or Alt) is set.
    ///     macOS's global hotkey API rejects shift-only chords (Shift+A
    ///     is just capital A in regular typing), so trying to register
    ///     one would fail at the OS layer. Failing at setup() time
    ///     causes the whole app to fail to start, which is much worse
    ///     than rejecting the value here and falling back to the
    ///     default hotkey.
    ///   - All modifier names map to known glyphs.
    ///   - The key string parses as a Code.
    pub fn to_shortcut(&self) -> Option<Shortcut> {
        if self.hotkey.modifiers.is_empty() {
            return None;
        }
        let mut mods = Modifiers::empty();
        for m in &self.hotkey.modifiers {
            match m.to_lowercase().as_str() {
                "super" | "meta" | "cmd" | "command" => mods |= Modifiers::SUPER,
                "shift" => mods |= Modifiers::SHIFT,
                "alt" | "option" => mods |= Modifiers::ALT,
                "control" | "ctrl" => mods |= Modifiers::CONTROL,
                _ => return None,
            }
        }
        let has_anchor = mods.intersects(Modifiers::SUPER | Modifiers::ALT | Modifiers::CONTROL);
        if !has_anchor {
            return None;
        }
        let code = Code::from_str(&self.hotkey.key).ok()?;
        Some(Shortcut::new(Some(mods), code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(modifiers: Vec<&str>, key: &str) -> Settings {
        Settings {
            hotkey: HotkeyConfig {
                modifiers: modifiers.into_iter().map(String::from).collect(),
                key: key.into(),
            },
            model: "claude-sonnet-4-6".into(),
            effort: "low".into(),
        }
    }

    #[test]
    fn default_settings_produce_valid_shortcut() {
        let s = Settings::default();
        assert!(s.to_shortcut().is_some(), "default hotkey must be valid");
    }

    #[test]
    fn empty_modifiers_rejected() {
        // The whole point of the recent fix: a hotkey with no modifiers
        // registered globally would hijack a bare key system-wide.
        let s = cfg(vec![], "KeyA");
        assert!(
            s.to_shortcut().is_none(),
            "empty modifier list must produce no shortcut",
        );
    }

    #[test]
    fn shift_only_rejected() {
        // Shift+letter is just capital-letter typing on macOS; the OS
        // refuses to bind a global hotkey to it. Reject early to avoid
        // failing inside setup() at startup.
        let s = cfg(vec!["shift"], "KeyA");
        assert!(
            s.to_shortcut().is_none(),
            "shift-only modifier must produce no shortcut",
        );
    }

    #[test]
    fn unknown_modifier_rejected() {
        let s = cfg(vec!["super", "made-up-modifier"], "KeyA");
        assert!(s.to_shortcut().is_none());
    }

    #[test]
    fn unknown_key_rejected() {
        let s = cfg(vec!["super", "shift"], "NotARealKey");
        assert!(s.to_shortcut().is_none());
    }

    #[test]
    fn accepts_combos_with_anchor_modifier() {
        for combo in [
            vec!["super"],
            vec!["alt"],
            vec!["control"],
            vec!["super", "shift"],
            vec!["control", "shift"],
            vec!["alt", "shift"],
            vec!["super", "control", "shift"],
        ] {
            let s = cfg(combo.clone(), "KeyA");
            assert!(
                s.to_shortcut().is_some(),
                "modifier combo {combo:?} should be accepted",
            );
        }
    }

    #[test]
    fn canonicalize_legacy_model_aliases() {
        assert_eq!(canonicalize_model("sonnet"), "claude-sonnet-4-6");
        assert_eq!(canonicalize_model("haiku"), "claude-haiku-4-5");
        assert_eq!(canonicalize_model("opus"), "claude-opus-4-7");
        // Future model names that match the safe format pass through.
        assert_eq!(canonicalize_model("claude-future-99"), "claude-future-99");
    }

    #[test]
    fn canonicalize_legacy_effort_default() {
        assert_eq!(canonicalize_effort("default"), "low");
        assert_eq!(canonicalize_effort(""), "low");
        assert_eq!(canonicalize_effort("medium"), "medium");
    }

    // ───── flag-injection defenses ──────────────────────────────────

    #[test]
    fn model_starting_with_dash_collapses_to_default() {
        // Without this guard, a model name like "--allowedTools" would
        // be passed verbatim as the value of `claude --model`. Worse,
        // `claude --model --allowedTools Bash` would re-enable Bash in
        // a window the user thinks is sandboxed.
        for injected in [
            "--allowedTools",
            "-h",
            "--mcp-config=/etc/passwd",
            "--dangerously-skip-permissions",
        ] {
            assert_eq!(
                canonicalize_model(injected),
                DEFAULT_MODEL,
                "model {injected:?} must canonicalize away",
            );
            assert!(!is_valid_model(injected));
        }
    }

    #[test]
    fn model_with_shell_metacharacters_collapses_to_default() {
        for bad in [
            "claude;rm",
            "claude|cat",
            "claude$()",
            "claude`x`",
            "claude sonnet",   // space
            "claude\nsonnet",  // newline
            "claude/sonnet",   // path sep
        ] {
            assert_eq!(canonicalize_model(bad), DEFAULT_MODEL);
            assert!(!is_valid_model(bad));
        }
    }

    #[test]
    fn empty_model_collapses_to_default() {
        assert_eq!(canonicalize_model(""), DEFAULT_MODEL);
        assert!(!is_valid_model(""));
    }

    #[test]
    fn overlong_model_collapses_to_default() {
        let long = "a".repeat(65);
        assert_eq!(canonicalize_model(&long), DEFAULT_MODEL);
        assert!(!is_valid_model(&long));
    }

    #[test]
    fn effort_outside_allowlist_collapses_to_default() {
        // Same flag-injection threat as model. Effort additionally has
        // a tight allowlist because the set of tiers is fixed.
        for bad in [
            "--allowedTools",
            "low ",        // trailing space — not in allowlist
            "extreme",     // unknown tier
            "LOW",         // case-sensitive
            "low\nmedium",
        ] {
            assert_eq!(
                canonicalize_effort(bad),
                DEFAULT_EFFORT,
                "effort {bad:?} must canonicalize away",
            );
            assert!(!is_valid_effort(bad));
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    if let Some(path) = settings_path(app) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut s) = serde_json::from_str::<Settings>(&content) {
                s.model = canonicalize_model(&s.model);
                s.effort = canonicalize_effort(&s.effort);
                return s;
            }
        }
    }
    Settings::default()
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) -> std::io::Result<()> {
    if let Some(path) = settings_path(app) {
        let json = serde_json::to_string_pretty(settings)
            .unwrap_or_else(|_| "{}".to_string());
        std::fs::write(&path, json)?;
    }
    Ok(())
}
