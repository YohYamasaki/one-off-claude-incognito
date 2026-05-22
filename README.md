# Claude Incognito

A lightweight macOS overlay that summons an incognito Claude chat window from anywhere with a global keyboard shortcut. Each window holds an independent ephemeral conversation; **nothing is persisted to disk**.

Built on Tauri 2 + the [`claude` CLI](https://docs.claude.com/en/docs/claude-code). Your existing Claude.ai login (or `ANTHROPIC_API_KEY`) is used — no extra credentials to manage.

## Why

- A "scratchpad" Claude that you can pull up from any app, type into for a minute, and walk away from
- True incognito — the local session JSONL is suppressed, the per-chat working directory is wiped on close, no chat history accumulates anywhere
- Multiple chats can be open in parallel (each hotkey press = new window)

## Requirements

- macOS 11 or later
- [`claude` CLI](https://docs.claude.com/en/docs/claude-code/quickstart) installed and logged in (`claude` once interactively to authenticate)
- Rust + Cargo
- Node.js + npm (only for the Tauri CLI runner)

## Build & Run

```bash
git clone <this repo>
cd claude-incognito
npm install
npm run tauri dev          # dev mode
npm run tauri build        # produces an .app + .dmg in src-tauri/target/release/bundle/
```

The bundled `.app` lives at `src-tauri/target/release/bundle/macos/Claude Incognito.app`. Move it into `/Applications` if you want, then launch it once to start the background daemon.

## Usage

| Action | How |
|--------|-----|
| New incognito chat | `Cmd+Shift+C` (or menu-bar tray → *New Incognito Chat*) |
| Send message | `Cmd+Enter` in the input field |
| Close window | Standard close button, or `Esc` |
| Quit the daemon | Menu-bar tray → *Quit Claude Incognito* |

There is **no main window** — the app lives in the menu bar (no Dock icon). Pressing the hotkey from any app spawns a floating chat window that stays above your other windows.

## How "incognito" is enforced

Each chat window runs its own `claude` subprocess with these flags:

- `--no-session-persistence` — Claude Code does not write the conversation JSONL to disk
- `--tools ""` — all built-in tools (file reads/writes, shell, web) are disabled
- Working directory is a fresh `tempfile::TempDir` that is destroyed when the window closes
- The per-window `~/.claude/projects/<encoded-tempdir>/` directory (if any side-files like `memory/` get materialized) is removed on close
- A system-prompt appendix forbids the model from emitting tool-call XML or writing any files
- `--model sonnet` for fast pure-chat responses

Result: nothing about the conversation survives the close button.

> The model still routes through Anthropic's servers, so Anthropic's normal data-handling policies apply. This is "no local trail" incognito, not "no network trail" incognito.

## Architecture

```
~/Documents/repositories/claude-incognito/
├── src/
│   ├── index.html            # chat shell
│   ├── chat.js               # streaming UI logic
│   ├── styles.css
│   └── marked.min.js         # bundled markdown renderer
└── src-tauri/
    └── src/
        ├── lib.rs            # global hotkey + tray + window spawning
        └── chat.rs           # per-window `claude` subprocess lifecycle
```

Per chat window: one `claude --print --input-format stream-json --output-format stream-json` subprocess in a tempdir. The Rust side pipes the user's input as `{"type":"user",...}` JSON lines into the subprocess's stdin, and forwards the stream-json events from stdout to the webview as Tauri events. Markdown deltas are re-rendered incrementally in the UI.

When a window is closed, its `ChatSession` is dropped — which kills the subprocess, removes the tempdir, and wipes the corresponding `~/.claude/projects/<encoded-path>/` directory.

## Changing the hotkey

Edit `src-tauri/src/lib.rs`, find the `Shortcut::new(...)` line, and change the modifiers/key. Available modifiers: `SUPER` (⌘), `SHIFT`, `ALT` (⌥), `CONTROL`. See [`tauri-plugin-global-shortcut`](https://docs.rs/tauri-plugin-global-shortcut) for the `Code` enum.

## License

MIT
