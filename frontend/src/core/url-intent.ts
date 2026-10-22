import type { SwapKind, UrlIntent } from "./types.js";

// What the page URL asked for at load, so the boot note can tell a name the
// link named (worth a note) from one restored out of localStorage (reset
// silently, ui-guidelines R5/R6d). Boot-only: takeUrlIntent() ends the window.

const KINDS: readonly SwapKind[] = ["source", "schema", "table", "filter"];

let asked: UrlIntent | null = null;

export function recordUrlIntent(params: URLSearchParams): void {
  asked = {};
  for (const kind of KINDS) {
    const value = params.get(kind);
    if (value) asked[kind] = value;
  }
}

export function takeUrlIntent(): UrlIntent {
  const taken = asked ?? {};
  asked = null;
  return taken;
}
