// Runtime-import-free seam. Feature modules (grid, sidebar, filter-ui) need to
// trigger a full reload but must not import controller.ts, which imports
// them — that back-edge is what a cycle is made of. main.ts registers the
// real implementation at bootstrap; a call before then is a no-op.
import type { ViewRequest } from "../core/store.js";

type LoadDataOpts = {
  resetScroll?: boolean;
  highlightNew?: boolean;
  auto?: boolean;
  next?: ViewRequest;
  replaceHistory?: boolean;
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
