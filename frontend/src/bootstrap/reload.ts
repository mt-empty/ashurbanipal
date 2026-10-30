// Runtime-import-free seam. Feature modules (grid, table-chips, filter-ui) need to
// trigger a full reload but must not import controller.ts, which imports
// them — that back-edge is what a cycle is made of. main.ts registers the
// real implementation at bootstrap; a call before then is a no-op.
import type { LoadReason } from "../core/perf-marks.js";
import type { ViewRequest } from "../core/store.js";

export type LoadDataOpts = {
  resetScroll?: boolean;
  highlightNew?: boolean;
  // An auto-refresh tick: it only re-fetches, so it never retries a dropped sort or filter,
  // opens the join dialog, or clears a message the user's own last action left.
  auto?: boolean;
  // A view to try; it replaces the state only if its data arrives.
  next?: ViewRequest;
  // Start-up and history restores correct the current entry rather than add one (ui-guidelines R16).
  replaceHistory?: boolean;
  // Next: the page after is likely wanted too, so it is asked for once this one shows.
  askNextPage?: boolean;
  reason?: LoadReason;
};

let impl: ((opts?: LoadDataOpts) => Promise<void>) | null = null;

export function registerLoadData(fn: (opts?: LoadDataOpts) => Promise<void>): void {
  impl = fn;
}

export function loadData(opts?: LoadDataOpts): Promise<void> {
  return impl ? impl(opts) : Promise.resolve();
}

// Every loadData takes a new token, and a pending one commits only while its
// token is current. A view change whose own loadData waits on a table list
// (source or schema switch, Back/Forward) calls supersedeLoads() first.
let loadToken = 0;

export function nextLoadToken(): number {
  return ++loadToken;
}

export function isCurrentLoad(token: number): boolean {
  return token === loadToken;
}

export function supersedeLoads(): void {
  loadToken++;
}
