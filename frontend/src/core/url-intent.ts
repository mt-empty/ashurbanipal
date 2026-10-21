import type { Swap, SwapKind } from "./types.js";

// What the page URL asked for at load, so a fallback can tell a name the link
// named (worth a note) from one restored out of localStorage (reset silently,
// ui-guidelines R5/R6d). Boot-only: takeSwaps() ends the window, so a later
// source or schema switch by the user never records anything.

const KINDS: readonly SwapKind[] = ["source", "schema", "table", "filter"];

let asked: Partial<Record<SwapKind, string>> | null = null;
let swaps: Swap[] = [];

export function recordUrlIntent(params: URLSearchParams): void {
  asked = {};
  for (const kind of KINDS) {
    const value = params.get(kind);
    if (value) asked[kind] = value;
  }
}

export function noteFallback(kind: SwapKind, from: string | null, got: string | null): void {
  if (asked === null || from === null || asked[kind] !== from) return;
  swaps.push({ kind, asked: from, got });
}

export function takeSwaps(): Swap[] {
  const taken = swaps;
  swaps = [];
  asked = null;
  return taken;
}
