import { describe, it, expect } from "vitest";
import {
  canonicalizeModel,
  modelShort,
  MODELS,
  MODEL_ALIAS,
  DEFAULT_MODEL,
} from "./models";

describe("canonicalizeModel", () => {
  it("maps the legacy short alias 'sonnet' to claude-sonnet-4-6", () => {
    expect(canonicalizeModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("maps 'opus' to the latest Opus (4.7)", () => {
    expect(canonicalizeModel("opus")).toBe("claude-opus-4-7");
  });

  it("maps 'haiku' to Haiku 4.5", () => {
    expect(canonicalizeModel("haiku")).toBe("claude-haiku-4-5");
  });

  it("passes already-canonical model names through unchanged", () => {
    expect(canonicalizeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(canonicalizeModel("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(canonicalizeModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("defaults to claude-sonnet-4-6 for empty/missing input", () => {
    expect(canonicalizeModel("")).toBe(DEFAULT_MODEL);
    expect(canonicalizeModel(undefined)).toBe(DEFAULT_MODEL);
    expect(canonicalizeModel(null)).toBe(DEFAULT_MODEL);
  });

  it("leaves unknown ids untouched (lets the CLI reject them)", () => {
    expect(canonicalizeModel("claude-mystery-9-9")).toBe("claude-mystery-9-9");
  });
});

describe("modelShort", () => {
  it("returns the curated short label for canonical ids", () => {
    expect(modelShort("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelShort("claude-opus-4-7")).toBe("Opus 4.7");
    expect(modelShort("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("resolves short aliases via the alias map", () => {
    expect(modelShort("sonnet")).toBe("Sonnet 4.6");
    expect(modelShort("opus")).toBe("Opus 4.7");
    expect(modelShort("haiku")).toBe("Haiku 4.5");
  });

  it("returns the id unchanged for unknown values", () => {
    expect(modelShort("claude-mystery-9-9")).toBe("claude-mystery-9-9");
  });
});

describe("MODELS", () => {
  it("lists exactly the supported models in popover display order", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
    ]);
  });

  it("each entry has both id and short label populated", () => {
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.short).toBe("string");
      expect(m.short.length).toBeGreaterThan(0);
    }
  });
});

describe("MODEL_ALIAS", () => {
  it("every alias points to an id that exists in MODELS", () => {
    const known = new Set(MODELS.map((m) => m.id));
    for (const [alias, full] of Object.entries(MODEL_ALIAS)) {
      expect(known.has(full)).toBe(true);
      // Also ensure the alias doesn't collide with a canonical id
      expect(known.has(alias)).toBe(false);
    }
  });
});
