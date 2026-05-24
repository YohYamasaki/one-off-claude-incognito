#!/bin/zsh
# End-to-end verification for One-off Claude Incognito.
#
# Static checks run anywhere. Interactive checks (hotkey, window
# lifecycle) need Accessibility permission for the Terminal that runs
# this script (System Settings → Privacy & Security → Accessibility).
#
# The interactive checks read the current hotkey from settings.json so
# they work regardless of whether you've customised it.
#
# Usage:
#   ./scripts/verify-e2e.sh               # full check
#   STATIC_ONLY=1 ./scripts/verify-e2e.sh # skip osascript checks

set -u

PROC="one-off-claude-incognito"
SETTINGS="$HOME/Library/Application Support/dev.yamasaki.one-off-claude-incognito/settings.json"
PASS=0
FAIL=0
SKIP=0

step() { printf "\n=== %s ===\n" "$1"; }
ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $1" >&2; FAIL=$((FAIL + 1)); }
skip() { echo "  ⊘ skipped: $1"; SKIP=$((SKIP + 1)); }

# ───────── derive the configured hotkey ─────────────────────────────

# Builds the osascript "keystroke ... using {...}" suffix from
# settings.json. Falls back to the default ⌘⇧C if the file is missing
# or the key isn't a plain letter / digit / space.
build_hotkey_command() {
  python3 - "$SETTINGS" <<'PY' 2>/dev/null
import json, sys
DEFAULT = 'keystroke "c" using {command down, shift down}'
try:
    path = sys.argv[1]
    with open(path) as f:
        s = json.load(f)
    h = s.get("hotkey") or {}
    mods = h.get("modifiers") or []
    key = h.get("key") or "KeyC"
    mod_map = {
        "super":   "command down",
        "shift":   "shift down",
        "alt":     "option down",
        "control": "control down",
    }
    parts = [mod_map[m] for m in mods if m in mod_map]
    mod_str = ", ".join(parts)
    if key.startswith("Key") and len(key) == 4:
        char = key[3].lower()
        print(f'keystroke "{char}" using {{{mod_str}}}')
    elif key.startswith("Digit") and len(key) == 6:
        char = key[5]
        print(f'keystroke "{char}" using {{{mod_str}}}')
    elif key == "Space":
        print(f'key code 49 using {{{mod_str}}}')
    else:
        # Unsupported key form for this helper — surface the default
        # so the test still runs (the user's actual hotkey will simply
        # not be exercised correctly).
        print(DEFAULT)
except FileNotFoundError:
    print(DEFAULT)
except Exception:
    print(DEFAULT)
PY
}

HOTKEY_CMD=$(build_hotkey_command)
HOTKEY_HUMAN=$(python3 - "$SETTINGS" <<'PY' 2>/dev/null
import json, sys
GLYPHS = {"super":"⌘","shift":"⇧","alt":"⌥","control":"⌃"}
ORDER  = ["control","alt","shift","super"]
try:
    with open(sys.argv[1]) as f: s = json.load(f)
    h = s.get("hotkey") or {}
    mods = h.get("modifiers") or []
    key = h.get("key") or "KeyC"
    if key.startswith("Key"):   k = key[3:]
    elif key.startswith("Digit"): k = key[5:]
    else: k = key
    glyphs = "".join(GLYPHS[m] for m in ORDER if m in mods)
    print(glyphs + k)
except Exception:
    print("⌘⇧C")
PY
)

# ───────── static checks ────────────────────────────────────────────

step "1. Tauri dev binary alive"
if pgrep -f "target/debug/${PROC}" >/dev/null; then
  ok "process running"
else
  bad "Tauri dev process not found — run \`npm run tauri dev\` first"
  exit 1
fi

step "2. Vite dev server serving the frontend"
if curl -sf -o /dev/null http://localhost:1420/; then
  ok "GET / returned 200"
else
  bad "Vite not reachable at http://localhost:1420/"
  exit 1
fi

CT=$(curl -sI http://localhost:1420/chat.ts | awk -F': *' 'tolower($1)=="content-type" {print $2}' | tr -d '\r\n')
case "$CT" in
  text/javascript*|application/javascript*) ok "/chat.ts served as JS ($CT)";;
  *) bad "/chat.ts served as '$CT' (expected JS)";;
esac

CT2=$(curl -sI http://localhost:1420/settings.ts | awk -F': *' 'tolower($1)=="content-type" {print $2}' | tr -d '\r\n')
case "$CT2" in
  text/javascript*|application/javascript*) ok "/settings.ts served as JS";;
  *) bad "/settings.ts served as '$CT2'";;
esac

for f in marked.min.js highlight.min.js hljs-dark.css hljs-light.css; do
  if curl -sfI "http://localhost:1420/$f" >/dev/null; then
    ok "/$f served from public/"
  else
    bad "/$f missing"
  fi
done

step "3. HTML references resolvable modules"
HTML=$(curl -s http://localhost:1420/)
# Vite appends a `?t=<timestamp>` cache-buster to recently modified TS
# modules, so we can't anchor on the closing quote.
echo "$HTML" | grep -qE '<script type="module" src="/chat\.ts(\?[^"]*)?"' \
  && ok "index.html references /chat.ts" \
  || bad "index.html missing /chat.ts"
echo "$HTML" | grep -q '<script src="/marked.min.js"' \
  && ok "index.html references /marked.min.js" \
  || bad "index.html missing /marked.min.js"
HTML2=$(curl -s http://localhost:1420/settings.html)
echo "$HTML2" | grep -qE '<script type="module" src="/settings\.ts(\?[^"]*)?"' \
  && ok "settings.html references /settings.ts" \
  || bad "settings.html missing /settings.ts"

step "4. Vitest unit suite green"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Capture vitest output so we can report the actual test count instead of
# hard-coding a number that drifts whenever we add tests.
VITEST_OUT=$(cd "$ROOT" && npm test --silent 2>&1) && VITEST_OK=1 || VITEST_OK=0
TEST_COUNT=$(echo "$VITEST_OUT" | grep -Eo '[0-9]+ passed' | tail -1 | awk '{print $1}')
if (( VITEST_OK == 1 )); then
  ok "all ${TEST_COUNT:-?} unit tests pass"
else
  bad "unit tests failing — run \`npm test\` to debug"
fi

# ───────── interactive checks ────────────────────────────────────────

if [[ -n "${STATIC_ONLY:-}" ]]; then
  echo ""
  echo "(STATIC_ONLY=1 — skipping interactive checks)"
else
  step "5. Accessibility permission"
  if osascript -e 'tell application "System Events" to keystroke ""' >/dev/null 2>&1; then
    ok "osascript can send keystrokes"

    count_windows() {
      osascript -e "tell application \"System Events\" to count windows of process \"$PROC\"" 2>/dev/null || echo 0
    }
    osa() { osascript -e "$1" >/dev/null 2>&1 || true; }

    echo ""
    echo "  Using configured hotkey: $HOTKEY_HUMAN"
    echo "  AppleScript: tell ... to $HOTKEY_CMD"

    step "6. Hotkey spawns a chat window"
    BEFORE=$(count_windows)
    osa "tell application \"System Events\" to $HOTKEY_CMD"
    sleep 2.5
    AFTER=$(count_windows)
    echo "  windows: $BEFORE → $AFTER"
    HOTKEY_OK=0
    if (( AFTER > BEFORE )); then
      ok "hotkey spawned a window"
      HOTKEY_OK=1
    else
      bad "hotkey did not spawn a window"
    fi

    step "7. Window stays alive after typing + submit"
    if (( HOTKEY_OK == 1 )); then
      osa 'tell application "System Events" to keystroke "ping"'
      sleep 0.4
      osa 'tell application "System Events" to key code 36'   # Return
      sleep 7
      STILL=$(count_windows)
      echo "  windows: $AFTER → $STILL"
      if (( STILL >= AFTER )); then
        ok "window still alive after submitting a message"
      else
        bad "window died on submit — JS likely threw"
      fi
    else
      skip "no window was spawned, can't test submit"
      STILL=$AFTER
    fi

    step "8. Esc closes the spawned window"
    if (( HOTKEY_OK == 1 )); then
      osa 'tell application "System Events" to key code 53'   # Esc
      sleep 1.5
      CLOSED=$(count_windows)
      echo "  windows: $STILL → $CLOSED"
      if (( CLOSED < STILL )); then
        ok "Esc closed the window"
      else
        bad "Esc did not close the window"
      fi
    else
      skip "no window to close"
    fi

    step "9. Hotkey works a second time"
    PRE=$(count_windows)
    osa "tell application \"System Events\" to $HOTKEY_CMD"
    sleep 2
    POST=$(count_windows)
    echo "  windows: $PRE → $POST"
    if (( POST > PRE )); then
      ok "second hotkey press also worked"
      osa 'tell application "System Events" to key code 53'   # cleanup
      sleep 1
    else
      bad "second hotkey press did nothing"
    fi
  else
    echo "  ⚠ osascript blocked — Accessibility not granted."
    echo "    System Settings → Privacy & Security → Accessibility → ✓ your terminal"
    skip "interactive checks (Accessibility missing)"
  fi
fi

# ───────── summary ───────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────"
echo "passed:  $PASS"
echo "failed:  $FAIL"
(( SKIP > 0 )) && echo "skipped: $SKIP"

if (( FAIL == 0 )); then
  echo "🟢 Verification complete."
  exit 0
else
  echo "🔴 $FAIL check(s) failed."
  exit 1
fi
