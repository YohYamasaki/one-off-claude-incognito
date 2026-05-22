// Effort levels accepted by `claude --effort`. Claude Code's UI offers an
// additional "Extra high" tier but the CLI rejects it, so the app exposes
// only the four CLI-supported levels.

export const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

export const DEFAULT_EFFORT = "low";

export function canonicalizeEffort(e: string | null | undefined): string {
  // The pre-rename build used "default" to mean "don't pass --effort".
  // Map that (and any empty/missing value) to "low", which is the new
  // entry-level the app exposes.
  if (!e || e === "default") return DEFAULT_EFFORT;
  return e;
}
