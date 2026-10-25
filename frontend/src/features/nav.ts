import { loadData, supersedeLoads } from "../bootstrap/reload.js";
import { $, reportError } from "../core/dom.js";
import {
  applyUrlExact,
  clearFilter,
  enterTable,
  persist,
  sameView,
  setSchema,
  state,
  tableInView,
  tableRequest,
  type ViewRequest,
  viewParams,
} from "../core/state.js";
import type { FilterCondition } from "../core/types.js";
import { parseFilterDsl } from "../lib/filter-dsl.js";
import { loadTables } from "./sidebar.js";

// FK-cell nav and the referenced-by drill-in: `table` filtered by `clause`,
// with no sort (a stale stored one would defeat loadData's drop-and-retry
// against the filter). `schema` is set only for a cross-schema target.
export function navigateWithSeededFilter(table: string, schema: string | undefined, clause: string): void {
  let ast: FilterCondition[];
  try {
    ast = parseFilterDsl(clause);
  } catch (e) {
    reportError(e);
    return;
  }
  const req: ViewRequest = {
    ...tableRequest(table),
    sort: null,
    order: "asc",
    restoredSort: false,
    filter: clause,
    ast,
  };
  if (!schema || schema === state.schema) {
    loadData({ next: req });
    return;
  }
  // The other schema's table list replaces this one first, so this switch
  // cannot wait for its rows (ui-guidelines R14).
  enterTable(table);
  state.sort = null;
  state.offset = 0;
  clearFilter();
  setSchema(schema);
  loadTables()
    .then(() => {
      // loadTables()'s stale-state fallback (sidebar.ts) silently resets
      // the view when `table` isn't in this schema's own /api/tables
      // listing (e.g. a partitioned referrer, which list_tables excludes)
      // — applying the filter here would seed it onto whatever table that
      // fallback landed on instead.
      if (tableInView() !== table) {
        reportError(new Error(`${table} isn't independently browsable in schema ${schema}`));
        return;
      }
      loadData({ next: req });
    })
    .catch(reportError);
}

// A history entry is a view (url.ts sameView); sort, page and filter replace
// the current entry, so Back returns to the previous view, not the previous
// page of rows. `written` is the search last written or restored; it stays
// null until the first load commits, which always replaces, since a deep link
// may name its view partially or fall back.
let written: string | null = null;
let restoringFromHistory = false; // true while a popstate-triggered reload is in flight

export function syncUrl(): void {
  const params = viewParams(state.view);
  const same = sameView(params, new URLSearchParams(location.search));
  params.set("limit", String(state.limit));
  params.set("offset", String(state.offset));
  if (state.sort) {
    params.set("sort", state.sort);
    params.set("order", state.order);
  }
  if (state.filter) params.set("filter", state.filter);
  const qs = `?${params}`;
  if (restoringFromHistory || written === null || same) {
    history.replaceState(null, "", qs);
  } else {
    history.pushState(null, "", qs);
  }
  written = location.search;
}

window.addEventListener("popstate", () => {
  // Start-up's own load chain would race a restore; reloading this entry is the clean one.
  if (written === null) {
    location.reload();
    return;
  }
  // A fragment-only step leaves the view as it is.
  if (location.search === written) return;
  written = location.search;
  supersedeLoads();
  const params = new URLSearchParams(location.search);
  // Exact reader: reproduce this history entry verbatim, absences included
  // (contrast url.ts's load-time overlay). Keep it separate from that overlay
  // reader — the header comment in url.ts says why.
  applyUrlExact(params);
  $<HTMLSelectElement>("source-select").value = state.source ?? "";
  $<HTMLSelectElement>("schema-select").value = state.schema ?? "";
  // syncUrl() only ever writes `schema` when the source at that history
  // point had more than one (loadSchemas pins state.schema to a concrete
  // name only then) — its presence/absence here is a reliable proxy for
  // this restored source's schema count, without a live re-fetch.
  $("schema-select-wrap").hidden = !state.schema;
  persist();
  restoringFromHistory = true;
  loadTables()
    .catch(reportError)
    .finally(() => {
      restoringFromHistory = false;
    });
});
