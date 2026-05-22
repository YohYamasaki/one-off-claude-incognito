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

/// Migrate legacy effort values. Old settings used "default" to mean
/// "don't pass --effort"; the UI now matches Claude Code's set of
/// {low, medium, high, max}, with "low" as the new entry-level.
pub fn canonicalize_effort(s: &str) -> String {
    match s {
        "default" | "" => "low".into(),
        other => other.into(),
    }
}

/// Map legacy short aliases (sonnet/opus/haiku) to specific versioned names.
/// Newer launches store the full name directly; this is only for migrating
/// settings files written before per-version selection existed.
pub fn canonicalize_model(s: &str) -> String {
    match s {
        "sonnet" => "claude-sonnet-4-6".into(),
        "haiku" => "claude-haiku-4-5".into(),
        "opus" => "claude-opus-4-7".into(),
        other => other.into(),
    }
}

impl Settings {
    pub fn to_shortcut(&self) -> Option<Shortcut> {
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
        let code = Code::from_str(&self.hotkey.key).ok()?;
        Some(Shortcut::new(Some(mods), code))
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
