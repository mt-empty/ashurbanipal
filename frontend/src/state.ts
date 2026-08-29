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
  filter: string;
}

// Persisted to localStorage and mirrored to the URL: table/sort/order/
// limit/offset only — never filter. A filter can contain data values, and
// a URL is even more exposed than localStorage (history, access logs,
// Referer headers). state.filter is the *applied* filter, decoupled from
// the live #filter input text — only committing (submit, or a
// click-to-filter action) updates it, so an unfinished edit never gets
// silently resent by an unrelated sort/page click.
export const state: State = {
  source: null, schema: null, table: null, sort: null, order: "asc", limit: 50, offset: 0, hiddenColumns: {}, filter: "",
};

try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  for (const k of ["source", "schema", "table", "sort", "order", "limit"] as const) {
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

export function persist(): void {
  const { source, schema, table, sort, order, limit, hiddenColumns } = state;
  localStorage.setItem(UI_KEY, JSON.stringify({ source, schema, table, sort, order, limit, hiddenColumns }));
}

// A stale table key or column name absent from the current table's
// columns simply matches nothing wherever it's consulted, so no separate
// validation pass is needed here.
export function hiddenColumnsForTable(): string[] {
  return state.hiddenColumns[state.table ?? ""] ?? [];
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

let lastPayload: TableData | null = null;
export function getLastPayload(): TableData | null {
  return lastPayload;
}
export function setLastPayload(data: TableData | null): void {
  lastPayload = data;
}

// Row identity for the "new since last refresh" highlight (grid.ts's
// row-new class). PK-only: a caller passes [] for a PK-less table and
// skips the diff, since hashing whole rows would flag an edited row as new
// and collide on duplicates. JSON.stringify of the PK value array is an
// injective, delimiter-free key. Held in memory only, never persisted — a
// PK value can be a data value (R6).
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
