import { describe, it, expect } from "vitest";
import { createImeTracker } from "./ime.js";

function fakeEvent({ isComposing = false, keyCode = 13 } = {}) {
  return { isComposing, keyCode };
}

describe("createImeTracker", () => {
  it("is not busy by default", () => {
    const ime = createImeTracker(() => 0);
    expect(ime.isBusy(fakeEvent())).toBe(false);
  });

  it("becomes busy while a composition is active", () => {
    const ime = createImeTracker(() => 0);
    ime.onCompositionStart();
    expect(ime.isBusy(fakeEvent())).toBe(true);
  });

  it("reports busy during the post-compositionend grace window (under 50 ms)", () => {
    let t = 1000;
    const ime = createImeTracker(() => t);
    ime.onCompositionStart();
    ime.onCompositionEnd();
    expect(ime.isBusy(fakeEvent())).toBe(true);
    t += 49;
    expect(ime.isBusy(fakeEvent())).toBe(true);
  });

  it("clears the grace window after 50 ms", () => {
    let t = 1000;
    const ime = createImeTracker(() => t);
    ime.onCompositionStart();
    ime.onCompositionEnd();
    t += 100;
    expect(ime.isBusy(fakeEvent())).toBe(false);
  });

  it("treats event.isComposing=true as busy even with no explicit composition", () => {
    const ime = createImeTracker(() => 0);
    expect(ime.isBusy(fakeEvent({ isComposing: true }))).toBe(true);
  });

  it("treats the legacy IME-in-progress keyCode 229 as busy", () => {
    const ime = createImeTracker(() => 0);
    expect(ime.isBusy(fakeEvent({ keyCode: 229 }))).toBe(true);
  });

  it("layered defenses are independent (any positive signal wins)", () => {
    let t = 0;
    const ime = createImeTracker(() => t);
    // Composition explicitly cleared, but event.isComposing still true → busy
    expect(ime.isBusy(fakeEvent({ isComposing: true }))).toBe(true);
    // Both signals false → not busy
    expect(ime.isBusy(fakeEvent())).toBe(false);
  });

  it("works with no event argument (defensive)", () => {
    const ime = createImeTracker(() => 0);
    ime.onCompositionStart();
    expect(ime.isBusy()).toBe(true);
  });
});
