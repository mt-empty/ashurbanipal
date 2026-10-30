import { prefetch } from "../core/api.js";
import { currentRequest, scopeQuery, sourceQuery, state, storedSortBeforeScope, tableDataPath } from "../core/state.js";

// Start-up's requests all go out at once, for the scope and view the URL or
// storage names, instead of each waiting for the one before. The usual
// start-up sequence then takes these answers where they match what it asks
// for, and asks again where they don't (a stale name).
export function prefetchStartup(): void {
  prefetch("/sources", "boot");
  prefetch(`/schemas${sourceQuery()}`, "boot");
  prefetch(`/tables${scopeQuery()}`, "boot");
  prefetch(`/table-counts${scopeQuery()}`, "boot");
  const req = currentRequest();
  if (req?.view.kind !== "table") return;
  const stored = opensWithStoredSort() ? storedSortBeforeScope(req.view.table) : undefined;
  prefetch(tableDataPath(stored ? { ...req, sort: stored.col, order: stored.order } : req), "boot");
}

// A fresh link without ?sort= opens with the table's remembered sort (R11); a
// reload or a history step reopens its entry exactly (R16).
export function opensWithStoredSort(): boolean {
  const navType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  return state.sort === null && navType !== "reload" && navType !== "back_forward";
}
