// Mapping helpers for rendering KeyboardEvent.code values as macOS-style
// glyphs (used in the settings window's hotkey pill).

export const MODIFIER_GLYPHS: Readonly<Record<string, string>> = {
  super: "⌘",
  shift: "⇧",
  alt: "⌥",
  control: "⌃",
};

// Standard macOS order for modifier display (left to right).
export const MODIFIER_ORDER: readonly string[] = [
  "control",
  "alt",
  "shift",
  "super",
];

const NAMED_KEYS: Readonly<Record<string, string>> = {
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

const ARROW_GLYPHS: Readonly<Record<string, string>> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

export function keyToGlyph(code: string): string {
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

export interface HotkeyConfig {
  readonly modifiers: readonly string[];
  readonly key: string;
}

export function formatHotkey(cfg: HotkeyConfig | null | undefined): string {
  if (!cfg) return "";
  const ordered = MODIFIER_ORDER.filter((m) => cfg.modifiers.includes(m));
  const glyphs = ordered.map((m) => MODIFIER_GLYPHS[m] || m).join("");
  return glyphs + keyToGlyph(cfg.key);
}
