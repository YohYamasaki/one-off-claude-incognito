// Model catalogue. The CLI accepts both short aliases ("sonnet", "opus",
// "haiku") and full versioned names ("claude-sonnet-4-6"). We use full names
// internally so the UI can show specific versions and the user's selection
// is unambiguous.

export interface Model {
  readonly id: string;
  readonly short: string;
}

export const MODELS: readonly Model[] = [
  { id: "claude-haiku-4-5", short: "Haiku 4.5" },
  { id: "claude-sonnet-4-5", short: "Sonnet 4.5" },
  { id: "claude-sonnet-4-6", short: "Sonnet 4.6" },
  { id: "claude-opus-4-6", short: "Opus 4.6" },
  { id: "claude-opus-4-7", short: "Opus 4.7" },
];

export const DEFAULT_MODEL = "claude-sonnet-4-6";

// Migration map from legacy short aliases to current full names.
// Each alias maps to the *latest* canonical version of that family so old
// settings continue to feel current.
export const MODEL_ALIAS: Readonly<Record<string, string>> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

export function canonicalizeModel(id: string | null | undefined): string {
  if (!id) return DEFAULT_MODEL;
  return MODEL_ALIAS[id] || id;
}

export function modelShort(id: string): string {
  const found = MODELS.find((m) => m.id === id);
  if (found) return found.short;
  const mapped = MODEL_ALIAS[id];
  if (mapped) {
    const fallback = MODELS.find((m) => m.id === mapped);
    if (fallback) return fallback.short;
  }
  return id;
}
