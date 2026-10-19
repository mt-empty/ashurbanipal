// Runtime-import-free seam. Feature modules (grid, sidebar, filter-ui) need to
// trigger a full reload but must not import controller.ts, which imports
// them — that back-edge is what a cycle is made of. main.ts registers the
// real implementation at bootstrap; a call before then is a no-op.
import type { ViewRequest } from "../core/store.js";

type LoadDataOpts = { resetScroll?: boolean; highlightNew?: boolean; next?: ViewRequest };

let impl: ((opts?: LoadDataOpts) => Promise<void>) | null = null;

export function registerLoadData(fn: (opts?: LoadDataOpts) => Promise<void>): void {
  impl = fn;
}

export function loadData(opts?: LoadDataOpts): Promise<void> {
  return impl ? impl(opts) : Promise.resolve();
}
