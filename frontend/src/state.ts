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
// never produces a request at all (spec/filter-dsl.md §4).
let appliedFilterAst: FilterCondition[] = [];
export function getAppliedFilterAst(): FilterCondition[] {
  return appliedFilterAst;
}
export function setAppliedFilterAst(ast: FilterCondition[]): void {
  appliedFilterAst = ast;
}

// A restored value (a remembered sort column, a URL-restored filter) is
// "unverified" from the moment it's restored until its first fetch returns —
// the one window where a 400 may be that value's fault (schema drift, or a
// link shared to another deployment) rather than the request's.
function staleRiskFlag() {
  let unverified = false;
  return {
    isUnverified: () => unverified,
    set: (value: boolean) => { unverified = value; },
  };
}
const filterRisk = staleRiskFlag();
const sortRisk = staleRiskFlag();

export function markFilterVerified(): void {
  filterRisk.set(false);
}
export function markStoredSortVerified(): void {
  sortRisk.set(false);
}

// Resets to no filter (ui-guidelines R5), box included — whether the backend
// rejected a restored filter or a scope switch left it written against
// columns the new scope doesn't share.
export function clearFilter(): void {
  state.filter = "";
  appliedFilterAst = [];
  filterRisk.set(false);
  $<HTMLInputElement>("filter").value = "";
}

// Shared by the module-init URL restore below and nav.ts's popstate handler.
// An absent `filter` key and a malformed one land in the same place: no
// filter at all (R5).
export function restoreFilterFromParams(params: URLSearchParams): void {
  const text = params.get("filter") ?? "";
  const ast = text ? tryParseFilterDsl(text) : null;
  if (!ast) { clearFilter(); return; }
  state.filter = text;
  appliedFilterAst = ast;
  filterRisk.set(true);
  $<HTMLInputElement>("filter").value = text;
}

// JSON.parse gives back `any`, so every persisted map is re-checked against
// the shape the restore loop assumes before it is read.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Restores the persisted view (never the filter — ui-guidelines R6). A
// malformed blob is discarded wholesale rather than migrated: it is cheap to
// lose and there is no reliable way to guess what it meant.
function restoreFromStorage(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    if (typeof saved.source === "string") state.source = saved.source;
    if (typeof saved.schema === "string") state.schema = saved.schema;
    if (typeof saved.table === "string") state.table = saved.table;
    // isFinite, not just typeof: a corrupted NaN/Infinity is still type
    // "number" but breaks the pager arithmetic in grid.ts that divides by it.
    if (typeof saved.limit === "number" && Number.isFinite(saved.limit)) state.limit = saved.limit;
    // Keyed by table name so hiding a column on one table never hides a
    // same-named column on another.
    if (isPlainObject(saved.hiddenColumns)) {
      for (const [table, cols] of Object.entries(saved.hiddenColumns)) {
        if (!Array.isArray(cols)) continue;
        const clean = cols.filter((c) => typeof c === "string");
        if (clean.length) state.hiddenColumns[table] = clean;
      }
    }
    // Same per-table keying as hiddenColumns.
    if (isPlainObject(saved.sortByTable)) {
      for (const [table, v] of Object.entries(saved.sortByTable)) {
        if (isPlainObject(v) && typeof v.col === "string") {
          state.sortByTable[table] = { col: v.col, order: v.order === "desc" ? "desc" : "asc" };
        }
      }
    }
    // Keyed by source name; values are plain schema-name strings.
    if (isPlainObject(saved.schemaBySource)) {
      for (const [source, schema] of Object.entries(saved.schemaBySource)) {
        if (typeof schema === "string") state.schemaBySource[source] = schema;
      }
    }
  } catch {
    localStorage.removeItem(UI_KEY);
  }
}

// Runs after restoreFromStorage(), because a shared or bookmarked link must
// reproduce that link's view rather than the visitor's own saved prefs.
function restoreFromUrl(): void {
  const params = new URLSearchParams(location.search);
  if (params.has("source")) state.source = params.get("source");
  if (params.has("schema")) state.schema = params.get("schema");
  if (params.has("table")) state.table = params.get("table");
  if (params.has("sort")) state.sort = params.get("sort");
  if (params.has("order")) state.order = params.get("order") === "desc" ? "desc" : "asc";
  if (params.has("limit")) state.limit = Number(params.get("limit")) || state.limit;
  if (params.has("offset")) state.offset = Number(params.get("offset")) || 0;
  restoreFilterFromParams(params);
}

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

// sort + order are remembered per table (like hiddenColumns): a column
// name is table-specific, so this never carries a sort across tables.
export function rememberSort(): void {
  if (!state.table) return;
  if (state.sort) state.sortByTable[state.table] = { col: state.sort, order: state.order };
  else delete state.sortByTable[state.table];
  sortRisk.set(false); // came from a click on a live header
  persist();
}

// Sets the active sort from what's stored for `table` (or clears it).
export function applyStoredSort(table: string | null): void {
  const stored = table ? state.sortByTable[table] : undefined;
  state.sort = stored?.col ?? null;
  state.order = stored?.order ?? "asc";
  sortRisk.set(state.sort !== null);
}

// The backend rejected a restored sort column (400). Drop it so the caller
// can retry unsorted (ui-guidelines R5).
function dropStoredSort(table: string | null): void {
  if (table) delete state.sortByTable[table];
  state.sort = null;
  state.order = "asc";
  sortRisk.set(false);
  persist();
}

// R11's retry ladder: a restored sort and a URL-restored filter are each
// stale-risk on a fresh load, but at most one is dropped per call, so the
// other still gets a chance to render — sort first, since it's the visitor's
// own incidental state while the filter is what a shared link was for.
export function dropOneStaleInput(): boolean {
  // An applied filter that already survived a fetch was typed on this visit,
  // so the 400 is the user's to see — it suppresses the whole ladder rather
  // than being silently discarded.
  if (state.filter !== "" && !filterRisk.isUnverified()) return false;
  if (sortRisk.isUnverified() && state.table) {
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

// R10: rows present now but absent from the previous fetch of the same view
// count as new, so a refresh can tint them — but only when the scope is
// unchanged (a sort/filter/page change makes every row look new) and the
// table has a PK to identify rows by. Also advances lastPayload/lastScopeKey
// to this fetch, since that bookkeeping only ever happens alongside this diff.
export function diffNewRows(data: TableData, highlightNew: boolean): { newRowKeys?: Set<string>; pkNames: string[] } {
  const prev = getLastPayload();
  const nowScope = scopeKey();
  let newRowKeys: Set<string> | undefined;
  let pkNames: string[] = [];
  if (highlightNew && prev && getLastScopeKey() === nowScope) {
    pkNames = data.columns.filter((c) => c.key === "pk").map((c) => c.name);
    if (pkNames.length) {
      const prevKeys = new Set(prev.rows.map((r) => rowKey(pkNames, r)));
      newRowKeys = new Set(data.rows.map((r) => rowKey(pkNames, r)).filter((k) => !prevKeys.has(k)));
    }
  }
  setLastPayload(data);
  setLastScopeKey(nowScope);
  return { newRowKeys, pkNames };
}

// state.ts's body is evaluated before any importing module's, so the restore
// has to run here rather than with main.ts's other bootstrap calls.
restoreFromStorage();
restoreFromUrl();
