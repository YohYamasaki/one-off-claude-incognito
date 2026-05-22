#!/bin/zsh
# End-to-end verification for One-off Claude Incognito.
#
# The "static" pass works in any shell. It confirms the build pipeline
# is wired up: Tauri dev process alive, Vite serving TS as JS, public
# assets reachable, lib tests still green.
#
# The "interactive" pass uses osascript to drive the global hotkey, type
# into the chat, and close the window. It needs Accessibility permission
# for the Terminal you're running it from (System Settings → Privacy &
# Security → Accessibility → ✓ Terminal).
#
# Run from an interactive Terminal session for the full check:
#   ./scripts/verify-e2e.sh
#
# To skip the interactive checks (e.g. from CI / nested shells):
#   STATIC_ONLY=1 ./scripts/verify-e2e.sh

set -u

PROC="one-off-claude-incognito"
PASS=0
FAIL=0

step() { printf "\n=== %s ===\n" "$1"; }
ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $1" >&2; FAIL=$((FAIL + 1)); }

# ───────── static checks ──────────────────────────────────────────────

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
  *) bad "/chat.ts served as '$CT' (expected JS) — Vite likely not transpiling";;
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
    bad "/$f missing from public/"
  fi
done

step "3. Index HTML references resolvable module"
HTML=$(curl -s http://localhost:1420/)
if echo "$HTML" | grep -q '<script type="module" src="/chat.ts"'; then
  ok "index.html references /chat.ts"
else
  bad "index.html missing /chat.ts script tag"
fi
if echo "$HTML" | grep -q '<script src="/marked.min.js"'; then
  ok "index.html references /marked.min.js"
else
  bad "index.html missing /marked.min.js script tag"
fi

step "4. Settings HTML references resolvable module"
HTML2=$(curl -s http://localhost:1420/settings.html)
if echo "$HTML2" | grep -q '<script type="module" src="/settings.ts"'; then
  ok "settings.html references /settings.ts"
else
  bad "settings.html missing /settings.ts script tag"
fi

step "5. Vitest unit suite green"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if (cd "$ROOT" && npm test --silent >/dev/null 2>&1); then
  ok "all 56 unit tests pass"
else
  bad "unit tests failing — see \`npm test\`"
fi

# ───────── interactive checks (osascript / Accessibility) ─────────────

if [[ -n "${STATIC_ONLY:-}" ]]; then
  echo ""
  echo "(skipping interactive checks: STATIC_ONLY set)"
else
  step "6. Accessibility permission for osascript"
  # `keystroke ""` is a no-op that fails only when the parent terminal
  # is missing Accessibility permission.
  if osascript -e 'tell application "System Events" to keystroke ""' >/dev/null 2>&1; then
    ok "osascript can send keystrokes"

    count_windows() {
      osascript -e "tell application \"System Events\" to count windows of process \"$PROC\"" 2>/dev/null || echo 0
    }
    osa() { osascript -e "$1" >/dev/null 2>&1 || true; }

    step "7. Cmd+Shift+C spawns a chat window"
    BEFORE=$(count_windows)
    osa 'tell application "System Events" to keystroke "c" using {command down, shift down}'
    sleep 2.5
    AFTER=$(count_windows)
    echo "  windows: $BEFORE → $AFTER"
    if (( AFTER > BEFORE )); then
      ok "hotkey spawned a window"
    else
      bad "hotkey did not spawn a window"
    fi

    step "8. Window stays alive after typing + submit"
    osa 'tell application "System Events" to keystroke "ping"'
    sleep 0.3
    osa 'tell application "System Events" to key code 36'   # Return
    sleep 6
    STILL=$(count_windows)
    if (( STILL >= AFTER )); then
      ok "window still alive after submitting a message"
    else
      bad "window died while submitting — JS likely threw"
    fi

    step "9. Esc closes the window"
    osa 'tell application "System Events" to key code 53'
    sleep 1.5
    CLOSED=$(count_windows)
    echo "  windows: $STILL → $CLOSED"
    if (( CLOSED < STILL )); then
      ok "Esc closed the window"
    else
      bad "Esc did not close the window"
    fi

    step "10. Hotkey works a second time (no stale state)"
    PRE=$(count_windows)
    osa 'tell application "System Events" to keystroke "c" using {command down, shift down}'
    sleep 2
    POST=$(count_windows)
    if (( POST > PRE )); then
      ok "second hotkey press also worked"
      osa 'tell application "System Events" to key code 53'   # cleanup
      sleep 1
    else
      bad "second hotkey press did nothing"
    fi
  else
    echo "  ⚠ osascript blocked — Terminal lacks Accessibility permission."
    echo "    System Settings → Privacy & Security → Accessibility → ✓ Terminal"
    echo "    (interactive checks skipped)"
  fi
fi

# ───────── summary ────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"

if (( FAIL == 0 )); then
  echo "🟢 Verification complete."
  exit 0
else
  echo "🔴 $FAIL check(s) failed."
  exit 1
fi
