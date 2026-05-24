import { describe, it, expect } from "vitest";

import { makeListenTarget } from "./listen-target";

describe("makeListenTarget", () => {
  // Regression guard for the "responses mixing between chats" bug.
  // The shape MUST be `{ target: { kind: 'WebviewWindow', label } }`.
  // Any drift (kind: 'Any', missing target, wrong label) causes either
  // total event loss (listener never fires) or cross-window event leak
  // (every window receives every window's deltas).
  it("returns a WebviewWindow-scoped target carrying the window label", () => {
    expect(makeListenTarget("chat-abc-123")).toEqual({
      target: { kind: "WebviewWindow", label: "chat-abc-123" },
    });
  });

  it("does not default to the catch-all 'Any' target", () => {
    // `kind: 'Any'` is the default of @tauri-apps/api `listen()` when
    // no options are passed, and it's specifically the value that
    // breaks our routing: tauri's `filter_target` for `emit_to` skips
    // `Any` listeners entirely. Lock the negative case so a careless
    // refactor doesn't silently fall back to it.
    const t = makeListenTarget("chat-xyz");
    expect(t.target.kind).not.toBe("Any");
    expect(t.target.kind).toBe("WebviewWindow");
  });

  it("uses the label verbatim — no munging, no prefix, no suffix", () => {
    // The Rust side calls `app.emit_to(label, …)` with the raw window
    // label, which becomes `EventTarget::AnyLabel{label}`. For
    // `filter_target` to match the listener's `WebviewWindow{label}`,
    // both labels must be byte-identical. Trimming, suffixing, etc.
    // would break the match.
    for (const label of [
      "chat-abc",
      "chat-9f8e7d6c-5b4a-3210-fedc-ba9876543210",
      "settings",
      "label with spaces",
      "ラベル",
    ]) {
      expect(makeListenTarget(label).target.label).toBe(label);
    }
  });

  it("never overlaps two distinct windows' targets", () => {
    const a = makeListenTarget("chat-a");
    const b = makeListenTarget("chat-b");
    expect(a.target.label).not.toBe(b.target.label);
  });
});
