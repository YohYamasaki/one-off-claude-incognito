#!/bin/zsh
# Fully automated 30s demo recording for One-off Claude Incognito.
# ffmpeg captures the screen while osascript drives the hotkey,
# typing, and window-close actions.
#
# Requirements (Terminal — or whichever shell — needs these once):
#   - System Settings → Privacy & Security → Screen Recording → Terminal ✓
#   - System Settings → Privacy & Security → Accessibility   → Terminal ✓
#
# Prereq: `npm run tauri dev` is already running and the menu-bar tray
# icon is visible.
#
# Usage:  ./scripts/record-demo.sh [output-file]

set -eu

OUT="${1:-$HOME/Desktop/one-off-claude-demo.mp4}"
DURATION=32

# --- preflight -------------------------------------------------------------

if ! ps ax | grep -q "[t]arget/debug/one-off-claude-incognito"; then
  echo "ERROR: Tauri dev process not found." >&2
  echo "Run \`npm run tauri dev\` in another terminal first." >&2
  exit 1
fi

if ! osascript -e 'tell application "System Events" to (count processes) > 0' >/dev/null 2>&1; then
  echo "ERROR: osascript is blocked from sending keystrokes." >&2
  echo "Grant Accessibility permission to your Terminal app:" >&2
  echo "  System Settings → Privacy & Security → Accessibility → ✓ Terminal" >&2
  exit 1
fi

SCREEN_IDX=$(
  ffmpeg -f avfoundation -list_devices true -i "" 2>&1 \
    | awk -F'[][]' '/Capture screen 0/ { print $4; exit }'
)
if [[ -z "$SCREEN_IDX" ]]; then
  echo "ERROR: couldn't detect a screen-capture device." >&2
  exit 1
fi

# --- timing-aware osascript helpers ---------------------------------------

osa() { osascript -e "$1" >/dev/null 2>&1; }
hotkey() {
  osa 'tell application "System Events" to keystroke "c" using {command down, shift down}'
}
type_text() {
  osa "tell application \"System Events\" to keystroke \"$1\""
}
press_return() {
  osa 'tell application "System Events" to key code 36'
}
press_escape() {
  osa 'tell application "System Events" to key code 53'
}

# --- countdown + record ---------------------------------------------------

echo "Recording → $OUT (${DURATION}s)"
for i in 3 2 1; do
  printf "  starting in %d...\r" "$i"
  sleep 1
done
echo "🔴 RECORDING + AUTOMATED DEMO          "

# Kick off ffmpeg in the background. It'll cap itself at $DURATION seconds.
ffmpeg -hide_banner -loglevel error \
  -f avfoundation -framerate 30 -capture_cursor 1 \
  -i "${SCREEN_IDX}:none" -t "$DURATION" \
  -pix_fmt yuv420p \
  -vf "scale=-2:720" \
  -c:v libx264 -preset slow -crf 22 \
  -movflags +faststart \
  -y "$OUT" &
FFMPEG_PID=$!

# --- the demo (~28s budget within a 32s recording) ------------------------

# t=0..2  : idle desktop / Terminal visible
sleep 2

# t=2..3.2 : summon window 1
hotkey
sleep 1.2

# t=3.2..5.2 : type the question
type_text "what is one-off chat"
sleep 0.3
press_return
# t≈5.5

# t=5.5..11 : streaming response
sleep 5.5

# t=11..12.2 : summon window 2 (cascades up-right of window 1)
hotkey
sleep 1.2

# t=12.2..14.2 : type next question
type_text "give me a one-line cat joke"
sleep 0.3
press_return
# t≈14.5

# t=14.5..23 : streaming response
sleep 8.5

# t=23..24.2 : close window 2 (whichever has focus — should be #2)
press_escape
sleep 1.2

# t=24.2..25.4 : close window 1 (focus should fall back to it since it's
# the only remaining always-on-top window in our app)
press_escape
sleep 1.5

# t≈27 — ffmpeg keeps recording for the remainder, then auto-stops at 32s
wait $FFMPEG_PID

echo ""
echo "✅ Saved $OUT ($(du -h "$OUT" | cut -f1))"
