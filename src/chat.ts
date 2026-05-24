import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import DOMPurify from "dompurify";

import { DEFAULT_MODEL, canonicalizeModel, modelShort } from "./lib/models";
import { EFFORT_LABELS, canonicalizeEffort } from "./lib/effort";
import { parseClaudeEvent } from "./lib/events";
import { createImeTracker } from "./lib/ime";
import { renderMarkdown as renderMarkdownImpl } from "./lib/markdown";
import { makeListenTarget } from "./lib/listen-target";

// External browser libraries loaded via <script> tags from `public/`.
declare global {
  interface Window {
    marked?: {
      parse(text: string, options?: { breaks?: boolean; gfm?: boolean }): string;
    };
    hljs?: {
      configure(opts: { ignoreUnescapedHTML?: boolean; throwUnescapedHTML?: boolean }): void;
      highlightElement(el: HTMLElement): void;
    };
  }
}

interface AssistantBubble {
  root: HTMLDivElement;
  thinking: HTMLDivElement;
  thinkingHeader: HTMLButtonElement;
  thinkingLabel: HTMLSpanElement;
  thinkingBody: HTMLDivElement;
  text: HTMLDivElement;
  thinkingStr: string;
  textStr: string;
  thinkingStartedAt: number | null;
  thinkingDoneAt: number | null;
  rafScheduled: boolean;
}

interface SessionInfo {
  model?: string | null;
  effort?: string | null;
}

const currentWindow = getCurrentWindow();

// ───────── module state ─────────

let isStreaming = false;
let currentBubble: AssistantBubble | null = null;

let sessionModel = DEFAULT_MODEL;
let sessionEffort = "low";

const MIN_HEIGHT = 240;
const MAX_HEIGHT = 760;
let lastSyncedHeight = MIN_HEIGHT;
let syncScheduled = false;
let resizeTweenActive = false;

const ime = createImeTracker();

// ───────── DOM ─────────

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element not found: #${id}`);
  return el as T;
}

const messagesEl = $<HTMLDivElement>("messages");
const inputEl = $<HTMLTextAreaElement>("input");
const composerEl = $<HTMLFormElement>("composer");
const sendBtnEl = $<HTMLButtonElement>("send-btn");
const closeBtnEl = $<HTMLButtonElement>("close-btn");
const modelChipEl = $<HTMLButtonElement>("model-chip");
const modelChipModel = $("model-chip-model");
const modelChipEffort = $("model-chip-effort");
const popoverEl = $("model-popover");
const popoverModelsEl = $("popover-models");
const popoverEffortsEl = $("popover-efforts");
const popoverStatusEl = $("popover-status");
const titlebarEl = $("titlebar");

// ───────── markdown / highlight ─────────

if (window.hljs && typeof window.hljs.configure === "function") {
  window.hljs.configure({
    ignoreUnescapedHTML: true,
    throwUnescapedHTML: false,
  });
}

// Claude's reply is untrusted input — see src/lib/markdown.ts for why the
// sanitization step here is the trust boundary for the whole app.
function renderMarkdown(text: string): string {
  return renderMarkdownImpl(text, {
    marked: window.marked,
    sanitizer: DOMPurify,
  });
}

function processCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>("pre > code").forEach((codeEl) => {
    if (window.hljs && !codeEl.classList.contains("hljs")) {
      try {
        window.hljs.highlightElement(codeEl);
      } catch {
        /* mid-stream incomplete fences sometimes trip hljs */
      }
    }
    const pre = codeEl.parentElement;
    if (pre && !pre.querySelector(".copy-btn")) {
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = codeEl.innerText || codeEl.textContent || "";
        navigator.clipboard
          .writeText(text)
          .then(() => {
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 1400);
          })
          .catch(() => {
            btn.textContent = "Failed";
          });
      });
      pre.appendChild(btn);
    }
  });
}

// ───────── bubble construction ─────────

const THINKING_DOTS_HTML =
  '<div class="thinking-dots" aria-label="Waiting"><span></span><span></span><span></span></div>';

function makeAssistantBubble(): AssistantBubble {
  const root = document.createElement("div");
  root.className = "bubble assistant streaming";

  const thinking = document.createElement("div");
  thinking.className = "thinking collapsed";
  thinking.hidden = true;

  const thinkingHeader = document.createElement("button");
  thinkingHeader.type = "button";
  thinkingHeader.className = "thinking-header";
  thinkingHeader.innerHTML = `
    <span class="thinking-spinner"></span>
    <span class="thinking-label">Thinking</span>
    <svg class="thinking-chevron" width="8" height="6" viewBox="0 0 8 6" aria-hidden="true">
      <path d="M1 1 L4 4 L7 1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  thinkingHeader.addEventListener("click", () => {
    thinking.classList.toggle("collapsed");
    debouncedSyncHeight();
  });

  const thinkingBody = document.createElement("div");
  thinkingBody.className = "thinking-body";

  thinking.appendChild(thinkingHeader);
  thinking.appendChild(thinkingBody);

  const text = document.createElement("div");
  text.className = "bubble-text";
  text.innerHTML = THINKING_DOTS_HTML;

  root.appendChild(thinking);
  root.appendChild(text);

  return {
    root,
    thinking,
    thinkingHeader,
    thinkingLabel: thinkingHeader.querySelector(".thinking-label") as HTMLSpanElement,
    thinkingBody,
    text,
    thinkingStr: "",
    textStr: "",
    thinkingStartedAt: null,
    thinkingDoneAt: null,
    rafScheduled: false,
  };
}

function addUserBubble(text: string): void {
  const div = document.createElement("div");
  div.className = "bubble user";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  debouncedSyncHeight();
}

function appendAssistantBubble(): AssistantBubble {
  const b = makeAssistantBubble();
  messagesEl.appendChild(b.root);
  scrollToBottom();
  debouncedSyncHeight();
  return b;
}

// ───────── rendering ─────────

function scheduleRender(): void {
  if (!currentBubble || currentBubble.rafScheduled) return;
  const b = currentBubble;
  b.rafScheduled = true;
  requestAnimationFrame(() => {
    b.rafScheduled = false;
    if (b.thinkingStr) {
      b.thinkingBody.textContent = b.thinkingStr;
    }
    if (b.textStr) {
      b.text.innerHTML = renderMarkdown(b.textStr);
      processCodeBlocks(b.text);
    }
    scrollToBottom();
    // Grow the window mid-stream too. The 60ms debounce + 6px change
    // threshold + tween-active lock in syncWindowHeight collapse the
    // rapid-fire delta calls into a few smooth resizes instead of
    // resizing on every token.
    debouncedSyncHeight();
  });
}

function showThinkingSection(b: AssistantBubble): void {
  if (b.thinking.hidden) {
    b.thinking.hidden = false;
    b.thinking.classList.remove("collapsed");
    b.thinkingStartedAt = performance.now();
  }
}

function finalizeThinking(b: AssistantBubble): void {
  if (b.thinking.hidden) return;
  if (b.thinkingDoneAt) return;
  b.thinkingDoneAt = performance.now();
  const elapsedMs = b.thinkingDoneAt - (b.thinkingStartedAt ?? b.thinkingDoneAt);
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  b.thinking.classList.add("done");
  b.thinking.classList.add("collapsed");
  b.thinkingLabel.textContent = `Thought for ${secs}s`;
}

function finalizeBubble(b: AssistantBubble): void {
  finalizeThinking(b);
  b.root.classList.remove("streaming");
  if (b.textStr) {
    b.text.innerHTML = renderMarkdown(b.textStr);
    processCodeBlocks(b.text);
  } else {
    b.text.innerHTML = '<span class="empty-note">(no response)</span>';
  }
  scrollToBottom();
  debouncedSyncHeight();
}

let scrollRafPending = false;
function scrollToBottom(): void {
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ───────── window auto-resize ─────────

function debouncedSyncHeight(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
    void syncWindowHeight();
  }, 60);
}

function computeDesiredHeight(): number {
  const titlebarH = titlebarEl.offsetHeight;
  const composerH = composerEl.offsetHeight;
  const messagesH = messagesEl.scrollHeight;
  const padding = 22;
  const desired = titlebarH + composerH + messagesH + padding;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, desired));
}

async function syncWindowHeight(): Promise<void> {
  if (resizeTweenActive) return;
  const target = computeDesiredHeight();
  if (Math.abs(target - lastSyncedHeight) < 6) return;
  await tweenWindowHeight(target);
  lastSyncedHeight = target;
}

async function tweenWindowHeight(targetH: number): Promise<void> {
  resizeTweenActive = true;
  try {
    const scale = await currentWindow.scaleFactor();
    const outer = await currentWindow.outerSize();
    const pos = await currentWindow.outerPosition();
    const startLogicalH = outer.height / scale;
    const startLogicalW = outer.width / scale;
    const startLogicalX = pos.x / scale;
    const startLogicalY = pos.y / scale;
    // Always anchor to the current bottom edge — respect manual window moves.
    const bottom = startLogicalY + startLogicalH;

    const startTime = performance.now();
    const duration = 220;

    await new Promise<void>((resolve) => {
      function step(now: number): void {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const h = Math.round(startLogicalH + (targetH - startLogicalH) * eased);
        const y = Math.round(bottom - h);
        void currentWindow.setSize(new LogicalSize(startLogicalW, h));
        void currentWindow.setPosition(new LogicalPosition(startLogicalX, y));
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
    lastSyncedHeight = targetH;
  } catch (e) {
    console.warn("resize failed", e);
  } finally {
    resizeTweenActive = false;
  }
}

// ───────── composer ─────────

function setStreaming(on: boolean): void {
  isStreaming = on;
  inputEl.disabled = on;
  sendBtnEl.disabled = on;
  if (!on) inputEl.focus();
}

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  inputEl.value = "";
  autoResize();
  addUserBubble(text);
  currentBubble = appendAssistantBubble();
  setStreaming(true);
  try {
    await invoke("send_message", { text });
  } catch (err) {
    if (currentBubble) {
      currentBubble.text.textContent = `Error: ${err}`;
      currentBubble.root.classList.remove("streaming");
    }
    setStreaming(false);
  }
}

function autoResize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  void send();
});

inputEl.addEventListener("input", () => {
  autoResize();
});

inputEl.addEventListener("compositionstart", () => ime.onCompositionStart());
inputEl.addEventListener("compositionend", () => ime.onCompositionEnd());

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !ime.isBusy(e)) {
    e.preventDefault();
    void send();
  } else if (e.key === "Escape" && !popoverEl.classList.contains("open")) {
    e.preventDefault();
    void currentWindow.close();
  }
});

closeBtnEl.addEventListener("click", () => void currentWindow.close());

// ───────── external link handling ─────────
//
// A markdown link in a Claude reply that the user clicks would, by
// default, navigate this WebView away from the chat UI — annoying
// even with benign links, and a quiet data-exfil channel if the link
// destination is attacker-chosen. Catch every anchor click and hand
// the URL to a Rust command that opens it in the user's default
// browser instead. The scheme allowlist sits on the Rust side
// (open_external_url) so a sanitizer bypass can't talk it into
// launching arbitrary URI handlers.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  const a = target.closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute("href") || "";
  // Intra-doc fragments scroll normally — never reach Rust.
  if (!href || href.startsWith("#")) return;
  e.preventDefault();
  void invoke("open_external_url", { url: href }).catch(() => {
    /* swallow — the important effect (no in-WebView navigation) already happened */
  });
});

// ───────── model/effort chip ─────────

function renderChip(): void {
  modelChipModel.textContent = modelShort(sessionModel);
  modelChipEffort.textContent = EFFORT_LABELS[sessionEffort] ?? sessionEffort;
  popoverModelsEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === sessionModel);
  });
  popoverEffortsEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === sessionEffort);
  });
}

async function openPopover(): Promise<void> {
  if (window.innerHeight < MAX_HEIGHT - 20) {
    await tweenWindowHeight(MAX_HEIGHT);
  }
  popoverEl.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      popoverEl.classList.add("open");
      modelChipEl.setAttribute("aria-expanded", "true");
    });
  });
  popoverStatusEl.textContent = "";
}

function closePopover(): void {
  popoverEl.classList.remove("open");
  modelChipEl.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!popoverEl.classList.contains("open")) popoverEl.hidden = true;
  }, 180);
}

modelChipEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (popoverEl.classList.contains("open")) closePopover();
  else void openPopover();
});

document.addEventListener("click", (e) => {
  if (!popoverEl.classList.contains("open")) return;
  const target = e.target as Node;
  if (popoverEl.contains(target) || modelChipEl.contains(target)) return;
  closePopover();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popoverEl.classList.contains("open")) {
    closePopover();
  }
});

// ───────── confirmation modal ─────────

interface ConfirmModalOpts {
  title: string;
  bodyHtml: string;
  confirmText?: string;
  danger?: boolean;
}

function showConfirmModal({ title, bodyHtml, confirmText = "OK", danger = false }: ConfirmModalOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = bodyHtml;
    const confirmBtn = $<HTMLButtonElement>("modal-confirm");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("danger", danger);
    const cancelBtn = $<HTMLButtonElement>("modal-cancel");

    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("open"));

    let done = false;
    const cleanup = (result: boolean): void => {
      if (done) return;
      done = true;
      modal.classList.remove("open");
      setTimeout(() => {
        modal.hidden = true;
      }, 200);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onCancel = (): void => cleanup(false);
    const onConfirm = (): void => cleanup(true);
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === modal) cleanup(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      }
    };

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);
    confirmBtn.focus();
  });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[ch] || ch,
  );
}

async function applyModelEffort(model: string, effort: string): Promise<void> {
  if (model === sessionModel && effort === sessionEffort) return;
  const hasMessages = messagesEl.querySelectorAll(".bubble").length > 0;

  if (hasMessages) {
    closePopover();
    const ok = await showConfirmModal({
      title: "Switch model?",
      bodyHtml: `Switching to <strong>${escapeHtml(modelShort(model))} · ${escapeHtml(EFFORT_LABELS[effort] ?? effort)}</strong> restarts this chat. The current conversation will be cleared.`,
      confirmText: "Switch & Clear",
      danger: true,
    });
    if (!ok) return;
  }

  popoverStatusEl.textContent = "Restarting…";
  try {
    await invoke("restart_session", { model, effort });
    sessionModel = model;
    sessionEffort = effort;
    renderChip();
    if (hasMessages) {
      messagesEl.innerHTML = "";
      const note = document.createElement("div");
      note.className = "system-note";
      note.textContent = `Switched to ${modelShort(model)} · ${EFFORT_LABELS[effort] ?? effort}`;
      messagesEl.appendChild(note);
      debouncedSyncHeight();
    }
    popoverStatusEl.textContent = "";
    closePopover();
  } catch (err) {
    popoverStatusEl.textContent = `Failed: ${err}`;
  }
}

popoverModelsEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    void applyModelEffort(btn.dataset.value ?? "", sessionEffort);
  });
});
popoverEffortsEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    void applyModelEffort(sessionModel, btn.dataset.value ?? "");
  });
});

// ───────── claude event handling ─────────
//
// Each chat window listens with a target pinned to its own webview
// label. Rust pairs this with `app.emit_to(label, …)` (see chat.rs).
//
// Why both halves matter: `WebviewWindow::emit` from Rust is
// actually a broadcast (uses the default Emitter trait impl), and a
// `listen()` call from JS without an explicit target registers as
// `EventTarget::Any` — which `emit_to` doesn't reach. Either half
// alone leaks: broadcast + Any listeners means every window
// receives every window's deltas (the "responses mixing between
// chats" bug). Filtered emit + targeted listener gets each delta to
// exactly the right window.
const listenTarget = makeListenTarget(currentWindow.label);

void listen<string>("claude-event", (e) => {
  let payload: unknown;
  try {
    payload = JSON.parse(e.payload);
  } catch (err) {
    console.error("parse error", err, e.payload);
    return;
  }

  const event = parseClaudeEvent(payload);
  if (!event) return;

  const b = currentBubble;

  switch (event.kind) {
    case "thinking-start":
      if (b) showThinkingSection(b);
      return;

    case "thinking-delta":
      if (!b) return;
      if (b.thinking.hidden) showThinkingSection(b);
      b.thinkingStr += event.text;
      scheduleRender();
      return;

    case "text-delta":
      if (!b) return;
      if (!b.thinkingDoneAt && !b.thinking.hidden) finalizeThinking(b);
      b.textStr += event.text;
      scheduleRender();
      return;

    case "result":
      if (b) {
        if (!b.textStr && event.result) b.textStr = event.result;
        finalizeBubble(b);
      }
      if (event.isError) {
        const errDiv = document.createElement("div");
        errDiv.className = "bubble error";
        errDiv.textContent = "(claude reported an error)";
        messagesEl.appendChild(errDiv);
      }
      setStreaming(false);
      return;

    case "assistant-final":
      if (b && !b.textStr) {
        b.textStr = event.text;
        scheduleRender();
      }
      return;
  }
}, listenTarget);

void listen("claude-end", () => {
  if (currentBubble) finalizeBubble(currentBubble);
  setStreaming(false);
}, listenTarget);

void listen<string>("session-error", (e) => {
  const div = document.createElement("div");
  div.className = "bubble error";
  div.textContent =
    `Failed to start claude subprocess: ${e.payload}\n\n` +
    "Make sure the `claude` CLI (Claude Code) is installed and that you have logged in. " +
    "See https://docs.claude.com/en/docs/claude-code/quickstart";
  messagesEl.appendChild(div);
  scrollToBottom();
  setStreaming(false);
}, listenTarget);

// ───────── boot ─────────

async function loadSessionInfo(): Promise<void> {
  try {
    const info = await invoke<SessionInfo | null>("get_window_session_info");
    if (info) {
      sessionModel = canonicalizeModel(info.model);
      sessionEffort = canonicalizeEffort(info.effort);
    } else {
      const s = await invoke<SessionInfo>("get_settings");
      sessionModel = canonicalizeModel(s.model);
      sessionEffort = canonicalizeEffort(s.effort);
    }
  } catch {
    /* keep defaults */
  }
  renderChip();
}

window.addEventListener("DOMContentLoaded", () => {
  inputEl.focus();
  void loadSessionInfo();
  void (async () => {
    try {
      const scale = await currentWindow.scaleFactor();
      const outer = await currentWindow.outerSize();
      lastSyncedHeight = outer.height / scale;
    } catch {
      /* nothing */
    }
  })();
});
