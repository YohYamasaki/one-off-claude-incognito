// "Incognito" enforcement at the filesystem level.
//
// Each chat session runs `claude` inside a fresh tempdir, and claude
// — even with `--no-session-persistence` set — *may* still touch
// ~/.claude/projects/<encoded-tempdir-path>/. We belt-and-suspenders
// that two ways:
//
//   1. ChatSession::drop removes the project dir on normal window
//      close. This is the fast path.
//
//   2. sweep_orphans() (this file), called once at app startup,
//      removes any project dirs left behind by crashed runs or hard
//      kills where Drop didn't get to run.
//
// Without #2, every `kill -9` of the app turns the incognito promise
// into a lie: the conversation JSONL persists under the user's home
// dir forever.

use std::fs;
use std::time::{Duration, SystemTime};

/// Substring marking a path-encoded tempdir name as one of ours. Keep
/// in sync with the `tempfile::Builder::new().prefix(...)` call in
/// `chat.rs::ChatSession::start`.
pub const TEMPDIR_PREFIX: &str = "one-off-claude-incognito-";

/// Sessions younger than this are skipped by the sweeper, in case the
/// user happens to be running two instances of the app concurrently
/// and we'd otherwise yank an active session out from under the other
/// process. A real session creates its dir within milliseconds, so 60s
/// is comfortably outside any startup race.
const ACTIVE_WINDOW: Duration = Duration::from_secs(60);

/// Encode an absolute filesystem path the way `claude` does for its
/// project dir names: every `/` becomes `-`. So
/// `/private/var/folders/AB/CD/T/one-off-claude-incognito-xyz` becomes
/// `-private-var-folders-AB-CD-T-one-off-claude-incognito-xyz`.
///
/// Used by ChatSession::drop to know which dir to remove, and (via
/// `is_session_project_dir`) by `sweep_orphans` to recognize leftovers.
pub fn encode_path(path: &std::path::Path) -> Option<String> {
    path.to_str().map(|s| s.replace('/', "-"))
}

/// True iff `name` looks like a path-encoded tempdir of ours.
///
/// We require BOTH our tempdir-prefix substring AND a recognized
/// temp-root prefix (`-private-var-folders-`, `-var-folders-`,
/// `-private-tmp-`, `-tmp-`) so that a user-created project dir whose
/// name *happens* to contain "one-off-claude-incognito-" (think
/// `~/projects/one-off-claude-incognito-notes/`) is left alone. Real
/// user project dirs encode as `-Users-...` or `-Volumes-...`, which
/// the temp-root check rules out.
pub fn is_session_project_dir(name: &str) -> bool {
    let from_temp_root = name.starts_with("-private-var-folders-")
        || name.starts_with("-var-folders-")
        || name.starts_with("-private-tmp-")
        || name.starts_with("-tmp-");
    from_temp_root && name.contains(TEMPDIR_PREFIX)
}

/// Sweep leftover session dirs that escaped Drop (crash / SIGKILL /
/// claude flushed after we stopped tracking it). Best-effort: any IO
/// error is silently ignored — losing the chance to nuke one orphan
/// is better than spamming the user with errors at startup.
pub fn sweep_orphans() {
    let Some(home) = dirs::home_dir() else { return };
    let projects = home.join(".claude").join("projects");
    let Ok(entries) = fs::read_dir(&projects) else { return };

    let cutoff = SystemTime::now().checked_sub(ACTIVE_WINDOW);

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !is_session_project_dir(&name_str) {
            continue;
        }
        if let (Some(cutoff), Ok(metadata)) = (cutoff, entry.metadata()) {
            if let Ok(mtime) = metadata.modified() {
                if mtime > cutoff {
                    // Possibly an active session from another instance.
                    continue;
                }
            }
        }
        let _ = fs::remove_dir_all(entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn encode_replaces_slashes_with_dashes() {
        assert_eq!(
            encode_path(Path::new(
                "/private/var/folders/AB/CD/T/one-off-claude-incognito-xyz",
            )),
            Some(
                "-private-var-folders-AB-CD-T-one-off-claude-incognito-xyz"
                    .to_string(),
            ),
        );
    }

    #[test]
    fn encode_is_none_for_non_utf8_path() {
        // Path::new on a literal str is always valid UTF-8, but the
        // function returns Option specifically so non-UTF-8 OsStr
        // paths (rare on macOS) gracefully degrade.
        assert!(encode_path(Path::new("/tmp/x")).is_some());
    }

    #[test]
    fn recognizes_our_session_dirs() {
        for name in [
            // canonicalized macOS tempdir paths (the common case)
            "-private-var-folders-AB-CD-T-one-off-claude-incognito-abc",
            "-private-var-folders-AB-CD-T-one-off-claude-incognito-xyz123",
            // non-canonical fallback (unlikely but possible)
            "-var-folders-AB-T-one-off-claude-incognito-q",
            // alternative tmpdir locations
            "-private-tmp-one-off-claude-incognito-w",
            "-tmp-one-off-claude-incognito-e",
        ] {
            assert!(is_session_project_dir(name), "should match: {name}");
        }
    }

    #[test]
    fn does_not_match_user_project_dirs() {
        // None of these are temp-rooted. Even if the user has a
        // project named `one-off-claude-incognito-notes` in their
        // repo collection, the encoded form starts with `-Users-…` or
        // `-Volumes-…`, never with a temp-root prefix.
        for name in [
            "-Users-yoheiyamasaki-Documents-repositories-Graphite",
            "-Users-yoheiyamasaki-projects-one-off-claude-incognito-notes",
            "-Volumes-Other-myproject",
            "",
            "garbage",
            "-Users-me-one-off-claude-incognito-thing",
            // close call: contains "tmp" but not as prefix
            "-Users-me-tmp-one-off-claude-incognito-fake",
        ] {
            assert!(
                !is_session_project_dir(name),
                "must NOT match: {name}",
            );
        }
    }

    #[test]
    fn temp_rooted_without_our_prefix_does_not_match() {
        // Other tempdirs from other tools share the temp root but
        // don't have our marker. Leave them alone.
        for name in [
            "-private-var-folders-AB-T-other-tool-xyz",
            "-tmp-some-other-software-abc",
        ] {
            assert!(!is_session_project_dir(name), "must NOT match: {name}");
        }
    }
}
