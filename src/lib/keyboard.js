// Mapping helpers for rendering KeyboardEvent.code values as macOS-style
// glyphs (used in the settings window's hotkey pill).

export const MODIFIER_GLYPHS = {
  super: "⌘",
  shift: "⇧",
  alt: "⌥",
  control: "⌃",
};

// Standard macOS order for modifier display (left to right).
export const MODIFIER_ORDER = ["control", "alt", "shift", "super"];

const NAMED_KEYS = {
  Space: "␣",
  Enter: "↩",
  Tab: "⇥",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
};

const ARROW_GLYPHS = { Up: "↑", Down: "↓", Left: "←", Right: "→" };

export function keyToGlyph(code) {
  if (!code) return "";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) {
    return ARROW_GLYPHS[code.slice(5)] || code;
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, code)) {
    return NAMED_KEYS[code];
  }
  return code;
}

export function formatHotkey(cfg) {
  if (!cfg) return "";
  const ordered = MODIFIER_ORDER.filter((m) => cfg.modifiers.includes(m));
  const glyphs = ordered.map((m) => MODIFIER_GLYPHS[m] || m).join("");
  return glyphs + keyToGlyph(cfg.key);
}
