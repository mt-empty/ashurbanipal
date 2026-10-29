// User Timing marks for measuring start-up and view switches, read by the
// DevTools Performance panel and tools/e2e-tests' perf harness. Only the
// latest of each name is kept, so auto-refresh can't grow the timeline.

export type LoadReason = "boot" | "chip" | "page" | "history" | "refresh" | "auto" | "other";

type MarkName = "scope-settled" | "tables-listed" | "load-start" | "rows-rendered";

export function markTiming(name: MarkName, reason?: LoadReason): void {
  const full = `ashurbanipal:${name}`;
  performance.clearMarks(full);
  performance.mark(full, reason ? { detail: { reason } } : undefined);
}
