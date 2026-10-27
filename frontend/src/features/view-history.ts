import { loadData, supersedeLoads } from "../bootstrap/reload.js";
import { $, reportError } from "../core/dom.js";
import {
  applyUrlExact,
  clearFilter,
  enterTable,
  persist,
  setSchema,
  state,
  tableRequest,
  type ViewRequest,
  viewParams,
} from "../core/state.js";
import type { FilterCondition } from "../core/types.js";
import { parseFilterDsl } from "../lib/filter-dsl.js";
import { loadSchemas } from "./scope-select.js";
import { loadTables } from "./table-chips.js";

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
  supersedeLoads();
  enterTable(table);
  state.sort = null;
  state.offset = 0;
  clearFilter();
  setSchema(schema);
  loadTables({ next: req })
    .then((outcome) => {
      // loadTables()'s stale-state fallback (table-chips.ts) drops `req` and
      // opens another table when `table` isn't in this schema's own
      // /api/tables listing (e.g. a partitioned referrer, which list_tables
      // excludes).
      if (outcome === "fell-back") {
        reportError(new Error(`${table} isn't independently browsable in schema ${schema}`));
      }
    })
    .catch(reportError);
}

// Every applied change to the URL is its own history entry (ui-guidelines
// R16); a load that writes the same query replaces. `written` is the search
// last written or restored, null until the first load commits.
let written: string | null = null;

// Start-up settled without a load committing (an empty schema, a failed
// first load): later history steps restore rather than reload.
export function noteStartupSettled(): void {
  written ??= location.search;
}

export function syncUrl(replaceHistory: boolean): void {
  const params = viewParams(state.view);
  params.set("limit", String(state.limit));
  params.set("offset", String(state.offset));
  if (state.sort) {
    params.set("sort", state.sort);
    params.set("order", state.order);
  }
  if (state.filter) params.set("filter", state.filter);
  const query = params.toString();
  // Both sides through one serializer, so a browser's own encoding can't fake a change.
  if (replaceHistory || query === new URLSearchParams(location.search).toString()) {
    history.replaceState(null, "", `?${query}`);
  } else {
    history.pushState(null, "", `?${query}`);
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
  const previousSource = state.source;
  // Exact reader: reproduce this history entry verbatim, absences included
  // (contrast url.ts's load-time overlay). Keep it separate from that overlay
  // reader — the header comment in url.ts says why.
  applyUrlExact(params);
  $<HTMLSelectElement>("source-select").value = state.source ?? "";
  $<HTMLSelectElement>("schema-select").value = state.schema ?? "";
  // syncUrl() writes `schema` only when loadSchemas pinned one: for two or
  // more schemas, or a lone schema the server has no default for. The second
  // keeps a one-option selector, so both checks stand in for a re-fetch.
  $("schema-select-wrap").hidden = !state.schema || $<HTMLSelectElement>("schema-select").options.length <= 1;
  persist();
  if (state.source === previousSource) {
    loadTables({ replaceHistory: true }).catch(reportError);
    return;
  }
  // Another source has its own schema list, so the selector's options must be re-fetched too.
  loadSchemas()
    .then((current) => (current ? loadTables({ replaceHistory: true }) : undefined))
    .catch(reportError);
});
