import { $ } from "./dom.js";
import { tryParseFilterDsl } from "./filter-dsl.js";
import type { FilterCondition, Row, TableData } from "./types.js";

const UI_KEY = "ashurbanipal_ui";

export interface State {
  source: string | null;
  schema: string | null;
  table: string | null;
  sort: string | null;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  hiddenColumns: Record<string, string[]>;
  // sort/order remembered per table, so returning to a table restores the
  // sort last chosen there (what lets the refresh button surface new rows
  // without re-sorting each visit — ui-guidelines R10/R11).
  sortByTable: Record<string, { col: string; order: "asc" | "desc" }>;
  // Schema is query scope like sort is, remembered per source so flipping
  // sources and back doesn't drop you into `public` again (ui-guidelines R12).
  schemaBySource: Record<string, string>;
  filter: string;
}

// Persisted to localStorage and mirrored to the URL: table/limit/offset
// directly, sort/order keyed per table. filter is the one exception — it
// goes in the URL (a link is already the shareable-view surface) but never
// to localStorage (so returning to a table later never silently reapplies
// a filter this visit didn't type — ui-guidelines R6). state.filter is the
// *applied* filter, decoupled from the live #filter input text — only
// committing (submit, a click-to-filter action, or a URL restore) updates
// it, so an unfinished edit never gets silently resent by an unrelated
// sort/page click.
export const state: State = {
  source: null, schema: null, table: null, sort: null, order: "asc", limit: 50, offset: 0, hiddenColumns: {}, sortByTable: {}, schemaBySource: {}, filter: "",
};

// state.filter stays the applied *text*; the AST that actually goes on the
// wire is derived from it once, at commit time, so unparseable box text
// never produces a request at all (spec/filter-dsl.md §4). Declared here,
// ahead of the URL-param restore block below, which needs to call
// setAppliedFilterAst() before it would otherwise be defined.
let appliedFilterAst: FilterCondition[] = [];
export function getAppliedFilterAst(): FilterCondition[] {
  return appliedFilterAst;
}
export function setAppliedFilterAst(ast: FilterCondition[]): void {
  appliedFilterAst = ast;
}

// A restored/persisted value (a remembered sort column, a URL-restored
// filter) is provisionally "unverified" from the moment it's restored until
// its first fetch either confirms it (markVerified — the value was fine) or
// the backend rejects it, at which point the caller drops the value itself
// (dropStoredSort / clearFilter below) rather than leaving it flagged. One
// instance per stale-risk input; a third one should reuse this rather than
// copy-pasting a third flag pair.
function staleRiskFlag() {
  let unverified = false;
  return {
    isUnverified: () => unverified,
    markUnverified: () => { unverified = true; },
    markVerified: () => { unverified = false; },
  };
}

// True only between a URL-sourced filter being restored and its first fetch
// returning. A filter nobody typed on this visit can name a column the
// table no longer has (schema drift, or a link shared to another
// deployment), so that one window is where a 400 may be the restored
// filter's fault. Declared ahead of the URL-param restore block, which
// sets it.
const filterRisk = staleRiskFlag();
export function markRestoredFilterVerified(): void {
  filterRisk.markVerified();
}

// Resets to no filter (ui-guidelines R5), box included. Used both for a
// restored filter the backend rejected (dropOneStaleInput below) and for an
// ordinary scope switch (table/schema/source, in sidebar.ts) — either way,
// the filter was written against columns the new scope doesn't share.
export function clearFilter(): void {
  state.filter = "";
  appliedFilterAst = [];
  filterRisk.markVerified();
  $<HTMLInputElement>("filter").value = "";
}

// Shared by the module-init URL restore below and nav.ts's popstate handler:
// applies (or silently resets, per R5) a `filter` query param. A missing key
// is indistinguishable from a present-but-empty one — both correctly leave/
// reset state.filter to "".
export function restoreFilterFromParams(params: URLSearchParams): void {
  const filterText = params.get("filter") ?? "";
  const ast = filterText ? tryParseFilterDsl(filterText) : [];
  state.filter = ast !== null ? filterText : ""; // malformed -> silent reset (R5)
  setAppliedFilterAst(ast ?? []);
  if (state.filter) filterRisk.markUnverified();
  else filterRisk.markVerified();
}

try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  for (const k of ["source", "schema", "table", "limit"] as const) {
    if (saved[k] !== undefined) (state as unknown as Record<string, unknown>)[k] = saved[k];
  }
  // Keyed by table name so hiding a column on one table never hides a
  // same-named column on another. A malformed value is discarded rather
  // than migrated — it's cheap to lose and there's no reliable way to
  // guess which table it belonged to.
  if (saved.hiddenColumns && typeof saved.hiddenColumns === "object" && !Array.isArray(saved.hiddenColumns)) {
    for (const [table, cols] of Object.entries(saved.hiddenColumns)) {
      if (!Array.isArray(cols)) continue;
      const clean = cols.filter((c) => typeof c === "string");
      if (clean.length) state.hiddenColumns[table] = clean;
    }
  }
  // Same per-table keying and discard-if-malformed rule as hiddenColumns.
  if (saved.sortByTable && typeof saved.sortByTable === "object" && !Array.isArray(saved.sortByTable)) {
    for (const [table, v] of Object.entries(saved.sortByTable)) {
      if (v && typeof v === "object" && typeof (v as { col?: unknown }).col === "string") {
        const { col, order } = v as { col: string; order?: unknown };
        state.sortByTable[table] = { col, order: order === "desc" ? "desc" : "asc" };
      }
    }
  }
  // Same discard-if-malformed rule; keyed by source name, values are plain
  // schema-name strings.
  if (saved.schemaBySource && typeof saved.schemaBySource === "object" && !Array.isArray(saved.schemaBySource)) {
    for (const [source, schema] of Object.entries(saved.schemaBySource)) {
      if (typeof schema === "string") state.schemaBySource[source] = schema;
    }
  }
} catch {
  localStorage.removeItem(UI_KEY);
}
// URL query params win over localStorage: opening a shared/bookmarked link
// should reproduce that link's view, not the visitor's own saved prefs.
const urlParams = new URLSearchParams(location.search);
if (urlParams.has("source")) state.source = urlParams.get("source");
if (urlParams.has("schema")) state.schema = urlParams.get("schema");
if (urlParams.has("table")) state.table = urlParams.get("table");
if (urlParams.has("sort")) state.sort = urlParams.get("sort");
if (urlParams.has("order")) state.order = urlParams.get("order") === "desc" ? "desc" : "asc";
if (urlParams.has("limit")) state.limit = Number(urlParams.get("limit")) || state.limit;
if (urlParams.has("offset")) state.offset = Number(urlParams.get("offset")) || 0;
restoreFilterFromParams(urlParams);

export function persist(): void {
  const { source, schema, table, limit, hiddenColumns, sortByTable, schemaBySource } = state;
  localStorage.setItem(UI_KEY, JSON.stringify({ source, schema, table, limit, hiddenColumns, sortByTable, schemaBySource }));
}

// A stale table key or column name absent from the current table's
// columns simply matches nothing wherever it's consulted, so no separate
// validation pass is needed here.
export function hiddenColumnsForTable(): string[] {
  return state.hiddenColumns[state.table ?? ""] ?? [];
}

// True only between applyStoredSort() restoring a sort and that sort's
// first fetch returning — the one window where a 400 might be the restored
// sort column's fault (schema drift, or storage from another database).
// filterRisk above is the same staleRiskFlag() shape, applied to a
// URL-restored filter instead of a remembered sort.
const sortRisk = staleRiskFlag();
export function markStoredSortVerified(): void {
  sortRisk.markVerified();
}

// sort + order are remembered per table (like hiddenColumns): a column
// name is table-specific, so this never carries a sort across tables.
export function rememberSort(): void {
  if (!state.table) return;
  if (state.sort) state.sortByTable[state.table] = { col: state.sort, order: state.order };
  else delete state.sortByTable[state.table];
  sortRisk.markVerified(); // came from a click on a live header
  persist();
}

// Sets the active sort from what's stored for `table` (or clears it).
export function applyStoredSort(table: string | null): void {
  const stored = table ? state.sortByTable[table] : undefined;
  state.sort = stored?.col ?? null;
  state.order = stored?.order ?? "asc";
  if (state.sort !== null) sortRisk.markUnverified();
  else sortRisk.markVerified();
}

// The backend rejected a restored sort column (400). Drop it so the caller
// can retry unsorted (ui-guidelines R5).
function dropStoredSort(table: string | null): void {
  if (table) delete state.sortByTable[table];
  state.sort = null;
  state.order = "asc";
  sortRisk.markVerified();
  persist();
}

// R11's retry-ladder policy: a restored sort and a URL-restored filter are
// each stale-risk on a fresh load, but at most one is dropped per call, so
// the other still gets a chance to render — sort first, since it's the
// visitor's own incidental state, while the filter is what a shared link
// was for. A filter typed on this visit isn't stale-risk and suppresses the
// sort drop instead of being retried itself. Returns whether it dropped
// anything, so the caller knows whether a retry is worth attempting.
export function dropOneStaleInput(): boolean {
  const filterIsUserTyped = state.filter !== "" && !filterRisk.isUnverified();
  if (sortRisk.isUnverified() && state.table && !filterIsUserTyped) {
    dropStoredSort(state.table);
    return true;
  }
  if (filterRisk.isUnverified()) {
    clearFilter();
    return true;
  }
  return false;
}

// Records the active schema against the current source (ui-guidelines R12),
// so #source-select's onchange can restore it instead of resetting to
// `public`. Only keyed when there's a source to switch between — a
// single-source deployment still persists state.schema via persist(), it
// just has no per-source map to populate.
export function rememberSchema(): void {
  if (state.source && state.schema) state.schemaBySource[state.source] = state.schema;
  persist();
}

// Only set once a multi-source/multi-schema deployment is confirmed
// (loadSources/loadSchemas) — a single-source, single-schema deployment
// never sends either param at all, identical to the wire shape before
// source/schema selection existed.
export function applyScopeParams(params: URLSearchParams): void {
  if (state.source) params.set("source", state.source);
  if (state.schema) params.set("schema", state.schema);
}

export function scopeQuery(): string {
  const params = new URLSearchParams();
  applyScopeParams(params);
  return params.size ? "?" + params : "";
}

// `api/schemas` (spec/protocol.md §5.7) takes `source` but not `schema` —
// it's what resolves schema in the first place — so it gets its own query
// builder rather than scopeQuery()'s combined source+schema.
export function sourceQuery(): string {
  return state.source ? "?" + new URLSearchParams({ source: state.source }) : "";
}

let lastPayload: TableData | null = null;
export function getLastPayload(): TableData | null {
  return lastPayload;
}
export function setLastPayload(data: TableData | null): void {
  lastPayload = data;
}

// Row identity for the new-since-refresh highlight. PK-only: whole-row
// hashing would mark an edited row as new and collide on duplicates. Never
// persisted — a PK value can be a data value (R6).
export function rowKey(pkNames: string[], row: Row): string {
  return JSON.stringify(pkNames.map((n) => row[n]));
}

// Identifies "the same view" between two fetches. A sort/filter/page/scope
// change makes every row look new, so the highlight only fires when this
// is unchanged from the fetch it's being diffed against.
export function scopeKey(): string {
  return JSON.stringify([
    state.source, state.schema, state.table, state.sort, state.order,
    state.offset, state.limit, appliedFilterAst,
  ]);
}

let lastScopeKey: string | null = null;
export function getLastScopeKey(): string | null {
  return lastScopeKey;
}
export function setLastScopeKey(key: string | null): void {
  lastScopeKey = key;
}
