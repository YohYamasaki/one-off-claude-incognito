const { invoke } = window.__TAURI__.core;
const currentWindow = window.__TAURI__.window.getCurrentWindow();

const MODIFIER_GLYPHS = {
  super: "⌘",
  shift: "⇧",
  alt: "⌥",
  control: "⌃",
};

const MODIFIER_ORDER = ["control", "alt", "shift", "super"];

const state = {
  current: null, // {hotkey:{modifiers,key}, model, effort}
  draft: null,
  recording: false,
};

const $ = (id) => document.getElementById(id);
const hotkeyText = $("hotkey-text");
const hotkeyDisplay = $("hotkey-display");
const hotkeyRecordBtn = $("hotkey-record");
const hotkeyHint = $("hotkey-hint");
const modelSeg = $("model-seg");
const effortSeg = $("effort-seg");
const saveBtn = $("save-btn");
const saveStatus = $("save-status");
const closeBtn = $("close-btn");

function keyToGlyph(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) {
    return { Up: "↑", Down: "↓", Left: "←", Right: "→" }[code.slice(5)] || code;
  }
  if (code === "Space") return "␣";
  if (code === "Enter") return "↩";
  if (code === "Tab") return "⇥";
  if (code === "Backquote") return "`";
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  return code;
}

function renderHotkey(cfg) {
  const ordered = MODIFIER_ORDER.filter((m) => cfg.modifiers.includes(m));
  const glyphs = ordered.map((m) => MODIFIER_GLYPHS[m] || m).join("");
  hotkeyText.textContent = glyphs + keyToGlyph(cfg.key);
}

function renderSegmented(group, value) {
  group.querySelectorAll("button").forEach((btn) => {
    btn.setAttribute("aria-checked", btn.dataset.value === value ? "true" : "false");
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

function setDraft(updater) {
  state.draft = updater({ ...state.draft });
  refreshUI();
  saveStatus.textContent = "";
  saveStatus.classList.remove("ok", "err");
}

function refreshUI() {
  if (!state.draft) return;
  renderHotkey(state.draft.hotkey);
  renderSegmented(modelSeg, state.draft.model);
  renderSegmented(effortSeg, state.draft.effort);
}

function canonicalizeEffort(e) {
  if (!e || e === "default") return "low";
  return e;
}

async function load() {
  const s = await invoke("get_settings");
  s.effort = canonicalizeEffort(s.effort);
  state.current = s;
  state.draft = JSON.parse(JSON.stringify(s));
  refreshUI();
}

function startRecording() {
  state.recording = true;
  hotkeyDisplay.classList.add("recording");
  hotkeyText.textContent = "press keys…";
  hotkeyHint.textContent = "Hold modifiers (⌘ ⇧ ⌥ ⌃) and press a key. Esc to cancel.";
}

function stopRecording() {
  state.recording = false;
  hotkeyDisplay.classList.remove("recording");
  hotkeyHint.textContent = "";
  refreshUI();
}

function handleRecordKeydown(e) {
  if (!state.recording) return;
  if (e.key === "Escape") {
    e.preventDefault();
    stopRecording();
    return;
  }
  // Ignore lone modifier presses
  if (
    e.code === "MetaLeft" ||
    e.code === "MetaRight" ||
    e.code === "ShiftLeft" ||
    e.code === "ShiftRight" ||
    e.code === "AltLeft" ||
    e.code === "AltRight" ||
    e.code === "ControlLeft" ||
    e.code === "ControlRight"
  ) {
    return;
  }
  e.preventDefault();
  const mods = [];
  if (e.metaKey) mods.push("super");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.ctrlKey) mods.push("control");
  if (mods.length === 0) {
    hotkeyHint.textContent = "At least one modifier is required (⌘ ⇧ ⌥ ⌃).";
    return;
  }
  setDraft((d) => ({ ...d, hotkey: { modifiers: mods, key: e.code } }));
  stopRecording();
}

hotkeyRecordBtn.addEventListener("click", () => {
  if (state.recording) stopRecording();
  else startRecording();
});
hotkeyDisplay.addEventListener("click", startRecording);

window.addEventListener("keydown", handleRecordKeydown, true);

modelSeg.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    setDraft((d) => ({ ...d, model: btn.dataset.value }));
  });
});

effortSeg.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    setDraft((d) => ({ ...d, effort: btn.dataset.value }));
  });
});

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  saveStatus.classList.remove("ok", "err");
  saveStatus.textContent = "Saving…";
  try {
    await invoke("update_settings", { newSettings: state.draft });
    state.current = JSON.parse(JSON.stringify(state.draft));
    saveStatus.textContent = "Saved ✓";
    saveStatus.classList.add("ok");
    setTimeout(() => {
      saveStatus.textContent = "";
      saveStatus.classList.remove("ok");
    }, 1800);
  } catch (e) {
    saveStatus.textContent = String(e);
    saveStatus.classList.add("err");
  } finally {
    saveBtn.disabled = false;
  }
});

closeBtn.addEventListener("click", () => currentWindow.close());

window.addEventListener("keydown", (e) => {
  if (!state.recording && e.key === "Escape") {
    e.preventDefault();
    currentWindow.close();
  }
});

load();
