import { describe, it, expect } from "vitest";
import {
  keyToGlyph,
  formatHotkey,
  MODIFIER_GLYPHS,
  MODIFIER_ORDER,
} from "./keyboard";

describe("keyToGlyph", () => {
  it("strips 'Key' prefix for letter codes", () => {
    expect(keyToGlyph("KeyC")).toBe("C");
    expect(keyToGlyph("KeyA")).toBe("A");
    expect(keyToGlyph("KeyZ")).toBe("Z");
  });

  it("strips 'Digit' prefix for number codes", () => {
    expect(keyToGlyph("Digit0")).toBe("0");
    expect(keyToGlyph("Digit5")).toBe("5");
  });

  it("renders arrow codes as Unicode arrows", () => {
    expect(keyToGlyph("ArrowUp")).toBe("↑");
    expect(keyToGlyph("ArrowDown")).toBe("↓");
    expect(keyToGlyph("ArrowLeft")).toBe("←");
    expect(keyToGlyph("ArrowRight")).toBe("→");
  });

  it("renders common named keys", () => {
    expect(keyToGlyph("Space")).toBe("␣");
    expect(keyToGlyph("Enter")).toBe("↩");
    expect(keyToGlyph("Tab")).toBe("⇥");
    expect(keyToGlyph("Escape")).toBe("⎋");
  });

  it("renders punctuation keys", () => {
    expect(keyToGlyph("Slash")).toBe("/");
    expect(keyToGlyph("Backslash")).toBe("\\");
    expect(keyToGlyph("Comma")).toBe(",");
    expect(keyToGlyph("Period")).toBe(".");
    expect(keyToGlyph("Backquote")).toBe("`");
  });

  it("returns the raw code for unknown values (function keys, etc.)", () => {
    expect(keyToGlyph("F19")).toBe("F19");
    expect(keyToGlyph("MediaPlayPause")).toBe("MediaPlayPause");
  });

  it("handles empty input gracefully", () => {
    expect(keyToGlyph("")).toBe("");
  });
});

describe("formatHotkey", () => {
  it("renders modifiers in macOS conventional order (⌃⌥⇧⌘)", () => {
    expect(formatHotkey({ modifiers: ["super", "shift"], key: "KeyC" })).toBe("⇧⌘C");
    // Order in the input array shouldn't matter
    expect(formatHotkey({ modifiers: ["shift", "super"], key: "KeyC" })).toBe("⇧⌘C");
    expect(
      formatHotkey({
        modifiers: ["control", "alt", "shift", "super"],
        key: "KeyA",
      }),
    ).toBe("⌃⌥⇧⌘A");
  });

  it("renders a hotkey with no modifiers (e.g. F-keys)", () => {
    expect(formatHotkey({ modifiers: [], key: "F19" })).toBe("F19");
  });

  it("falls back gracefully on a null/undefined config", () => {
    expect(formatHotkey(null)).toBe("");
    expect(formatHotkey(undefined)).toBe("");
  });

  it("renders single-modifier hotkeys", () => {
    expect(formatHotkey({ modifiers: ["super"], key: "Space" })).toBe("⌘␣");
    expect(formatHotkey({ modifiers: ["alt"], key: "ArrowUp" })).toBe("⌥↑");
  });
});

describe("MODIFIER_GLYPHS", () => {
  it("covers the four supported modifiers", () => {
    expect(Object.keys(MODIFIER_GLYPHS).sort()).toEqual(["alt", "control", "shift", "super"]);
  });
});

describe("MODIFIER_ORDER", () => {
  it("orders modifiers left-to-right ⌃⌥⇧⌘", () => {
    expect(MODIFIER_ORDER).toEqual(["control", "alt", "shift", "super"]);
  });
});
