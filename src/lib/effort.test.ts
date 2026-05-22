import { describe, it, expect } from "vitest";
import { canonicalizeEffort, EFFORT_LABELS, DEFAULT_EFFORT } from "./effort";

describe("canonicalizeEffort", () => {
  it("migrates the legacy 'default' value to 'low'", () => {
    expect(canonicalizeEffort("default")).toBe("low");
  });

  it("maps empty/missing values to the default 'low'", () => {
    expect(canonicalizeEffort("")).toBe(DEFAULT_EFFORT);
    expect(canonicalizeEffort(undefined)).toBe(DEFAULT_EFFORT);
    expect(canonicalizeEffort(null)).toBe(DEFAULT_EFFORT);
  });

  it("passes valid CLI levels through unchanged", () => {
    for (const e of ["low", "medium", "high", "max"]) {
      expect(canonicalizeEffort(e)).toBe(e);
    }
  });
});

describe("EFFORT_LABELS", () => {
  it("exposes exactly the four CLI-supported levels", () => {
    expect(Object.keys(EFFORT_LABELS).sort()).toEqual([
      "high",
      "low",
      "max",
      "medium",
    ]);
  });

  it("does not include the legacy 'default'", () => {
    expect(EFFORT_LABELS.default).toBeUndefined();
  });
});
