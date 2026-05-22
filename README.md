# One-off Claude Incognito

A lightweight macOS overlay that summons a one-off, incognito Claude chat window from anywhere with a global keyboard shortcut. Each window holds an independent ephemeral conversation; **nothing is persisted to disk**.

Built on Tauri 2 + the [`claude` CLI](https://docs.claude.com/en/docs/claude-code). Your existing Claude.ai login (or `ANTHROPIC_API_KEY`) is used — no extra credentials to manage.

## Why

- A "scratchpad" Claude that you can pull up from any app, type into for a minute, and walk away from
- True incognito — the local session JSONL is suppressed, the per-chat working directory is wiped on close, no chat history accumulates anywhere
- Multiple chats can be open in parallel (each hotkey press = new window)

## Install

Grab the latest `.dmg` from the [Releases page](https://github.com/YohYamasaki/one-off-claude-incognito/releases), drag the app into `/Applications`, and launch it once. The app lives in the menu bar (no Dock icon).

> The build is unsigned — on first launch, right-click the app → **Open** → **Open** anyway to bypass Gatekeeper.

## Requirements

- macOS 11 or later (Apple Silicon for the prebuilt DMG; Intel users should build from source)
- [`claude` CLI](https://docs.claude.com/en/docs/claude-code/quickstart) installed and logged in (`claude` once interactively to authenticate)

## Build from source

```bash
git clone https://github.com/YohYamasaki/one-off-claude-incognito.git
cd one-off-claude-incognito
npm install
npm run tauri dev          # dev mode
npm run tauri build        # produces an .app + .dmg in src-tauri/target/release/bundle/
```

The bundled `.app` lives at `src-tauri/target/release/bundle/macos/One-off Claude Incognito.app`.

## Usage

| Action | How |
|--------|-----|
| New one-off chat | `⌘⇧C` (or menu-bar tray → *New Incognito Chat*) |
| Send message | `⏎` (`⇧⏎` for newline) |
| Close window | Custom × button, `Esc`, `⌘W`, or `⌘Q` |
| Quit the daemon | Menu-bar tray → *Quit*, or `⌘⇧Q` |

There is **no main window** — the app lives in the menu bar. Pressing the hotkey from any app spawns a floating chat window that stays above your other windows.

## How "incognito" is enforced

Each chat window runs its own `claude` subprocess with these flags:

- `--no-session-persistence` — Claude Code does not write the conversation JSONL to disk
- `--tools ""` — all built-in tools (file reads/writes, shell, web) are disabled
- Working directory is a fresh `tempfile::TempDir` that is destroyed when the window closes
- The per-window `~/.claude/projects/<encoded-tempdir>/` directory (if any side-files like `memory/` get materialized) is removed on close
- A system-prompt appendix forbids the model from emitting tool-call XML or writing any files

Result: nothing about the conversation survives the close button.

> The model still routes through Anthropic's servers, so Anthropic's normal data-handling policies apply. This is "no local trail" incognito, not "no network trail" incognito.

## Architecture

```
one-off-claude-incognito/
├── src/
│   ├── index.html            # chat shell
│   ├── chat.js               # streaming UI logic
│   ├── settings.html         # settings window
│   ├── settings.js
│   ├── styles.css
│   ├── marked.min.js         # bundled markdown renderer
│   └── highlight.min.js      # bundled syntax highlighter
└── src-tauri/
    └── src/
        ├── lib.rs            # global hotkey + tray + window spawning + menu
        ├── chat.rs           # per-window `claude` subprocess lifecycle
        └── settings.rs       # persisted hotkey / model / effort
```

Per chat window: one `claude --print --input-format stream-json --output-format stream-json` subprocess in a tempdir. The Rust side pipes the user's input as `{"type":"user",...}` JSON lines into the subprocess's stdin, and forwards the stream-json events from stdout to the webview as Tauri events. Markdown deltas are re-rendered incrementally in the UI.

When a window is closed, its `ChatSession` is dropped — which kills the subprocess, removes the tempdir, and wipes the corresponding `~/.claude/projects/<encoded-path>/` directory.

## Configuration

Open **Settings** from the tray menu (or `⌘,`) to change:

- **Hotkey** — record any modifier+key combination
- **Default model** — Haiku 4.5 / Sonnet 4.5 / Sonnet 4.6 / Opus 4.6 / Opus 4.7
- **Default effort** — Low / Medium / High / Max (matches the `claude` CLI's `--effort` flag)

Settings live at `~/Library/Application Support/dev.yamasaki.one-off-claude-incognito/settings.json`.

## License

MIT
