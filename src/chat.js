const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const currentWindow = window.__TAURI__.window.getCurrentWindow();
const { LogicalSize, LogicalPosition } = window.__TAURI__.window;
const WINDOW_LABEL = currentWindow.label;

// ───────── module state ─────────

let isStreaming = false;
let currentBubble = null;

const MODELS = [
  { id: "claude-haiku-4-5", short: "Haiku 4.5" },
  { id: "claude-sonnet-4-5", short: "Sonnet 4.5" },
  { id: "claude-sonnet-4-6", short: "Sonnet 4.6" },
  { id: "claude-opus-4-6", short: "Opus 4.6" },
  { id: "claude-opus-4-7", short: "Opus 4.7" },
];

const MODEL_ALIAS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

function modelShort(id) {
  const found = MODELS.find((m) => m.id === id);
  if (found) return found.short;
  const mapped = MODEL_ALIAS[id];
  if (mapped) return MODELS.find((m) => m.id === mapped)?.short || id;
  return id;
}

const EFFORT_LABELS = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

function canonicalizeEffort(e) {
  if (!e || e === "default") return "low";
  return e;
}

let sessionModel = "claude-sonnet-4-6";
let sessionEffort = "low";

// Window auto-resize bookkeeping
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 760;
let lastSyncedHeight = MIN_HEIGHT;
let syncScheduled = false;
let resizeTweenActive = false;

// IME composition tracking (Japanese / CJK input fix)
let imeComposing = false;
let lastCompositionEndTime = 0;

// ───────── DOM ─────────

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const composerEl = $("composer");
const sendBtnEl = $("send-btn");
const closeBtnEl = $("close-btn");
const modelChipEl = $("model-chip");
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

function renderMarkdown(text) {
  if (!text) return "";
  if (window.marked) {
    return window.marked.parse(text, { breaks: true, gfm: true });
  }
  const escaped = text.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
  return `<pre>${escaped}</pre>`;
}

function processCodeBlocks(container) {
  if (!container) return;
  container.querySelectorAll("pre > code").forEach((codeEl) => {
    if (window.hljs && !codeEl.classList.contains("hljs")) {
      try {
        window.hljs.highlightElement(codeEl);
      } catch (_) {}
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

function makeAssistantBubble() {
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
    thinkingLabel: thinkingHeader.querySelector(".thinking-label"),
    thinkingBody,
    text,
    thinkingStr: "",
    textStr: "",
    thinkingStartedAt: null,
    thinkingDoneAt: null,
    rafScheduled: false,
  };
}

function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "bubble user";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  debouncedSyncHeight();
}

function appendAssistantBubble() {
  const b = makeAssistantBubble();
  messagesEl.appendChild(b.root);
  scrollToBottom();
  debouncedSyncHeight();
  return b;
}

// ───────── rendering ─────────

function scheduleRender() {
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
    // Intentionally NOT calling debouncedSyncHeight here — we only want to
    // resize the window when bubble *count* changes, not on every streamed
    // delta. Streaming text simply scrolls inside the current size.
  });
}

function showThinkingSection(b) {
  if (!b) return;
  if (b.thinking.hidden) {
    b.thinking.hidden = false;
    b.thinking.classList.remove("collapsed");
    b.thinkingStartedAt = performance.now();
  }
}

function finalizeThinking(b) {
  if (!b || b.thinking.hidden) return;
  if (b.thinkingDoneAt) return;
  b.thinkingDoneAt = performance.now();
  const elapsedMs = b.thinkingDoneAt - (b.thinkingStartedAt || b.thinkingDoneAt);
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  b.thinking.classList.add("done");
  b.thinking.classList.add("collapsed");
  b.thinkingLabel.textContent = `Thought for ${secs}s`;
}

function finalizeBubble(b) {
  if (!b) return;
  finalizeThinking(b);
  b.root.classList.remove("streaming");
  if (b.textStr) {
    b.text.innerHTML = renderMarkdown(b.textStr);
    processCodeBlocks(b.text);
  } else {
    b.text.innerHTML = '<span class="empty-note">(no response)</span>';
  }
  scrollToBottom();
  // Sync once at the end so the whole completed response fits.
  debouncedSyncHeight();
}

let scrollRafPending = false;
function scrollToBottom() {
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ───────── window auto-resize ─────────

function debouncedSyncHeight() {
  if (syncScheduled) return;
  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
    syncWindowHeight();
  }, 60);
}

function computeDesiredHeight() {
  const titlebarH = titlebarEl.offsetHeight;
  const composerH = composerEl.offsetHeight;
  const messagesH = messagesEl.scrollHeight;
  const padding = 22;
  const desired = titlebarH + composerH + messagesH + padding;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, desired));
}

async function syncWindowHeight() {
  if (resizeTweenActive) return;
  const target = computeDesiredHeight();
  if (Math.abs(target - lastSyncedHeight) < 6) return;
  await tweenWindowHeight(target);
  lastSyncedHeight = target;
}

async function tweenWindowHeight(targetH) {
  resizeTweenActive = true;
  try {
    const scale = await currentWindow.scaleFactor();
    const outer = await currentWindow.outerSize();
    const pos = await currentWindow.outerPosition();
    const startLogicalH = outer.height / scale;
    const startLogicalW = outer.width / scale;
    const startLogicalX = pos.x / scale;
    const startLogicalY = pos.y / scale;
    // Always anchor to the current bottom edge. If the user has manually
    // moved the window, that's where we should grow from — never snap them
    // back to an older remembered anchor.
    const bottom = startLogicalY + startLogicalH;

    const startTime = performance.now();
    const duration = 220;

    await new Promise((resolve) => {
      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const h = Math.round(startLogicalH + (targetH - startLogicalH) * eased);
        const y = Math.round(bottom - h);
        currentWindow.setSize(new LogicalSize(startLogicalW, h));
        currentWindow.setPosition(new LogicalPosition(startLogicalX, y));
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

function setStreaming(on) {
  isStreaming = on;
  inputEl.disabled = on;
  sendBtnEl.disabled = on;
  if (!on) inputEl.focus();
}

async function send() {
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

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});

inputEl.addEventListener("input", () => {
  // Only grow the textarea itself; don't trigger a window resize on every
  // keystroke.
  autoResize();
});

// IME composition tracking
inputEl.addEventListener("compositionstart", () => {
  imeComposing = true;
});
inputEl.addEventListener("compositionend", () => {
  imeComposing = false;
  lastCompositionEndTime = performance.now();
});

inputEl.addEventListener("keydown", (e) => {
  // Triple-defense against IME confirm-Enter sending the message
  const imeBusy =
    imeComposing ||
    e.isComposing ||
    e.keyCode === 229 ||
    performance.now() - lastCompositionEndTime < 50;

  if (e.key === "Enter" && !e.shiftKey && !imeBusy) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape" && !popoverEl.classList.contains("open")) {
    e.preventDefault();
    currentWindow.close();
  }
});

closeBtnEl.addEventListener("click", () => currentWindow.close());

// ───────── model/effort chip ─────────

function renderChip() {
  modelChipModel.textContent = modelShort(sessionModel);
  modelChipEffort.textContent = EFFORT_LABELS[sessionEffort] || sessionEffort;
  popoverModelsEl.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === sessionModel);
  });
  popoverEffortsEl.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === sessionEffort);
  });
}

async function openPopover() {
  // Grow the window all the way to MAX_HEIGHT so the popover has plenty of
  // room. The user can collapse back later via auto-resize on next message.
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

function closePopover() {
  popoverEl.classList.remove("open");
  modelChipEl.setAttribute("aria-expanded", "false");
  setTimeout(() => {
    if (!popoverEl.classList.contains("open")) popoverEl.hidden = true;
  }, 180);
}

modelChipEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (popoverEl.classList.contains("open")) closePopover();
  else openPopover();
});

document.addEventListener("click", (e) => {
  if (!popoverEl.classList.contains("open")) return;
  if (popoverEl.contains(e.target) || modelChipEl.contains(e.target)) return;
  closePopover();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popoverEl.classList.contains("open")) {
    closePopover();
  }
});

// ───────── confirmation modal ─────────

function showConfirmModal({ title, bodyHtml, confirmText = "OK", danger = false }) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = bodyHtml;
    const confirmBtn = $("modal-confirm");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("danger", danger);
    const cancelBtn = $("modal-cancel");

    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("open"));

    let done = false;
    const cleanup = (result) => {
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
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    const onBackdrop = (e) => {
      if (e.target === modal) cleanup(false);
    };
    const onKey = (e) => {
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

async function applyModelEffort(model, effort) {
  if (model === sessionModel && effort === sessionEffort) return;
  const hasMessages = messagesEl.querySelectorAll(".bubble").length > 0;

  if (hasMessages) {
    closePopover();
    const ok = await showConfirmModal({
      title: "Switch model?",
      bodyHtml: `Switching to <strong>${escapeHtml(modelShort(model))} · ${escapeHtml(EFFORT_LABELS[effort] || effort)}</strong> restarts this chat. The current conversation will be cleared.`,
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
      note.textContent = `Switched to ${modelShort(model)} · ${EFFORT_LABELS[effort] || effort}`;
      messagesEl.appendChild(note);
      debouncedSyncHeight();
    }
    popoverStatusEl.textContent = "";
    closePopover();
  } catch (err) {
    popoverStatusEl.textContent = `Failed: ${err}`;
  }
}

popoverModelsEl.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    applyModelEffort(btn.dataset.value, sessionEffort);
  });
});
popoverEffortsEl.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    applyModelEffort(sessionModel, btn.dataset.value);
  });
});

// ───────── claude event handling ─────────

listen(`claude-event-${WINDOW_LABEL}`, (e) => {
  let payload;
  try {
    payload = JSON.parse(e.payload);
  } catch (err) {
    console.error("parse error", err, e.payload);
    return;
  }
  const b = currentBubble;
  if (!b && payload.type !== "system" && payload.type !== "result") return;

  if (payload.type === "stream_event") {
    const ev = payload.event;
    if (!ev) return;

    if (ev.type === "content_block_start") {
      const block = ev.content_block || {};
      if (block.type === "thinking" && b) {
        showThinkingSection(b);
      }
      return;
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "thinking_delta" && b) {
        if (b.thinking.hidden) showThinkingSection(b);
        b.thinkingStr += d.thinking || "";
        scheduleRender();
      } else if (d.type === "text_delta" && b) {
        if (!b.thinkingDoneAt && !b.thinking.hidden) {
          finalizeThinking(b);
        }
        b.textStr += d.text || "";
        scheduleRender();
      }
      return;
    }
    return;
  }

  if (payload.type === "result") {
    if (b) {
      if (!b.textStr && payload.result) {
        b.textStr = payload.result;
      }
      finalizeBubble(b);
    }
    if (payload.is_error) {
      const errDiv = document.createElement("div");
      errDiv.className = "bubble error";
      errDiv.textContent = `(claude reported an error)`;
      messagesEl.appendChild(errDiv);
    }
    setStreaming(false);
    return;
  }

  if (payload.type === "assistant" && b && !b.textStr) {
    const content = payload.message && payload.message.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) {
        b.textStr = text;
        scheduleRender();
      }
    }
  }
});

listen(`claude-end-${WINDOW_LABEL}`, () => {
  if (currentBubble) finalizeBubble(currentBubble);
  setStreaming(false);
});

listen(`session-error-${WINDOW_LABEL}`, (e) => {
  const div = document.createElement("div");
  div.className = "bubble error";
  div.textContent =
    `Failed to start claude subprocess: ${e.payload}\n\n` +
    "Make sure the `claude` CLI (Claude Code) is installed and that you have logged in. " +
    "See https://docs.claude.com/en/docs/claude-code/quickstart";
  messagesEl.appendChild(div);
  scrollToBottom();
  setStreaming(false);
});

// ───────── boot ─────────

function canonicalizeModel(id) {
  return MODEL_ALIAS[id] || id;
}

async function loadSessionInfo() {
  try {
    const info = await invoke("get_window_session_info");
    if (info) {
      sessionModel = canonicalizeModel(info.model || "claude-sonnet-4-6");
      sessionEffort = canonicalizeEffort(info.effort);
    } else {
      const s = await invoke("get_settings");
      sessionModel = canonicalizeModel(s.model || "claude-sonnet-4-6");
      sessionEffort = canonicalizeEffort(s.effort);
    }
  } catch (_) {}
  renderChip();
}

window.addEventListener("DOMContentLoaded", async () => {
  inputEl.focus();
  await loadSessionInfo();
  try {
    const scale = await currentWindow.scaleFactor();
    const outer = await currentWindow.outerSize();
    lastSyncedHeight = outer.height / scale;
  } catch (_) {}
});
