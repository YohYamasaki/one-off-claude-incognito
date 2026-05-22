import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { formatHotkey, HotkeyConfig } from "./lib/keyboard";
import { canonicalizeEffort } from "./lib/effort";

interface Settings {
  hotkey: HotkeyConfig;
  model: string;
  effort: string;
}

interface State {
  current: Settings | null;
  draft: Settings | null;
  recording: boolean;
}

const currentWindow = getCurrentWindow();

const state: State = {
  current: null,
  draft: null,
  recording: false,
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element not found: #${id}`);
  return el as T;
}

const hotkeyText = $("hotkey-text");
const hotkeyDisplay = $<HTMLButtonElement>("hotkey-display");
const hotkeyRecordBtn = $<HTMLButtonElement>("hotkey-record");
const hotkeyHint = $("hotkey-hint");
const modelSeg = $("model-seg");
const effortSeg = $("effort-seg");
const saveBtn = $<HTMLButtonElement>("save-btn");
const saveStatus = $("save-status");
const closeBtn = $<HTMLButtonElement>("close-btn");

function renderHotkey(cfg: HotkeyConfig): void {
  hotkeyText.textContent = formatHotkey(cfg);
}

function renderSegmented(group: HTMLElement, value: string): void {
  group.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.setAttribute("aria-checked", btn.dataset.value === value ? "true" : "false");
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

function setDraft(updater: (s: Settings) => Settings): void {
  if (!state.draft) return;
  state.draft = updater({ ...state.draft });
  refreshUI();
  saveStatus.textContent = "";
  saveStatus.classList.remove("ok", "err");
}

function refreshUI(): void {
  if (!state.draft) return;
  renderHotkey(state.draft.hotkey);
  renderSegmented(modelSeg, state.draft.model);
  renderSegmented(effortSeg, state.draft.effort);
}

async function load(): Promise<void> {
  const s = await invoke<Settings>("get_settings");
  s.effort = canonicalizeEffort(s.effort);
  state.current = s;
  state.draft = JSON.parse(JSON.stringify(s)) as Settings;
  refreshUI();
}

function startRecording(): void {
  state.recording = true;
  hotkeyDisplay.classList.add("recording");
  hotkeyText.textContent = "press keys…";
  hotkeyHint.textContent =
    "Hold modifiers (⌘ ⇧ ⌥ ⌃) and press a key. Esc to cancel.";
}

function stopRecording(): void {
  state.recording = false;
  hotkeyDisplay.classList.remove("recording");
  hotkeyHint.textContent = "";
  refreshUI();
}

function handleRecordKeydown(e: KeyboardEvent): void {
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
  const mods: string[] = [];
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

modelSeg.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    setDraft((d) => ({ ...d, model: btn.dataset.value ?? d.model }));
  });
});

effortSeg.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    setDraft((d) => ({ ...d, effort: btn.dataset.value ?? d.effort }));
  });
});

saveBtn.addEventListener("click", async () => {
  if (!state.draft) return;
  saveBtn.disabled = true;
  saveStatus.classList.remove("ok", "err");
  saveStatus.textContent = "Saving…";
  try {
    await invoke("update_settings", { newSettings: state.draft });
    state.current = JSON.parse(JSON.stringify(state.draft)) as Settings;
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

closeBtn.addEventListener("click", () => void currentWindow.close());

window.addEventListener("keydown", (e) => {
  if (!state.recording && e.key === "Escape") {
    e.preventDefault();
    void currentWindow.close();
  }
});

void load();
