import { prefetch } from "../core/api.js";
import { currentRequest, dataParams, scopeQuery, sourceQuery } from "../core/state.js";

// Start-up's requests all go out at once, for the scope and view the URL or
// storage names, instead of each waiting for the one before. The usual
// start-up sequence then takes these answers where they match what it asks
// for, and asks again where they don't (a stale name, a remembered sort).
export function prefetchStartup(): void {
  prefetch("/sources", "boot");
  prefetch(`/schemas${sourceQuery()}`, "boot");
  prefetch(`/tables${scopeQuery()}`, "boot");
  prefetch(`/table-counts${scopeQuery()}`, "boot");
  const req = currentRequest();
  if (req?.view.kind === "table") prefetch(`/tables/data?${dataParams(req)}`, "boot");
}
