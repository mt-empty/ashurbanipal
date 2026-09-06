import { tryParseFilterDsl } from "../lib/filter-dsl.js";
import { collectNewRowKeys } from "../lib/row-diff.js";
import { $ } from "./dom.js";
import type { FilterCondition, TableData } from "./types.js";

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
//
// Feature modules mutate scope through the named transitions below
// (switchSource / switchSchema / switchTable), not by assigning fields
// ad hoc; a site that deliberately diverges (grid.ts's FK navigation)
// says why inline.
export const state: State = {
  source: null,
  schema: null,
  table: null,
  sort: null,
  order: "asc",
  limit: 50,
  offset: 0,
  hiddenColumns: {},
  sortByTable: {},
  schemaBySource: {},
  filter: "",
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
    set: (value: boolean) => {
      unverified = value;
    },
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

// Shared by url.ts's load-time and popstate readers. An absent `filter` key
// and a malformed one land in the same place: no filter at all (R5).
export function restoreFilterFromParams(params: URLSearchParams): void {
  const text = params.get("filter") ?? "";
  const ast = text ? tryParseFilterDsl(text) : null;
  if (!ast) {
    clearFilter();
    return;
  }
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
// lose and there is no reliable way to guess what it meant. url.ts's
// initState() runs this before layering the URL over it.
export function restoreFromStorage(): void {
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
  } catch (e) {
    // A corrupt persisted blob (truncated write, pre-migration schema) otherwise
    // reverts the view to defaults with no trace. removeItem can itself throw
    // where getItem did (site data blocked), and this runs at bootstrap.
    console.warn("ashurbanipal: discarding unreadable view state", e);
    try {
      localStorage.removeItem(UI_KEY);
    } catch {
      /* best-effort */
    }
  }
}

export function persist(): void {
  const { source, schema, table, limit, hiddenColumns, sortByTable, schemaBySource } = state;
  // Best-effort: a throw here (quota, private mode) must not abort the caller,
  // which almost always follows persist() with a loadData()/loadTables() the
  // user still needs. Unlike the single-string writes in theme.ts /
  // sidebar-resize.ts, this blob grows per table/source touched, so a quota
  // failure is plausible on a long session — warn so it isn't wholly invisible.
  try {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({ source, schema, table, limit, hiddenColumns, sortByTable, schemaBySource }),
    );
  } catch (e) {
    console.warn("ashurbanipal: could not persist view state", e);
  }
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

// ---- named scope transitions ----
// Each of the three sidebar scope switches has exactly one caller, so they take
// no options.
// grid.ts's FK navigation deliberately does not use switchTable — it seeds a
// filter rather than clearing one, drops the remembered sort (a stale one
// would defeat loadData's drop-and-retry against the same-fetch filter), and
// lets submitFilter own the offset reset — so it stays explicit there.

// Pins state.schema to a concrete name and syncs the #schema-select value +
// the per-source memory (R12). The step shared by an explicit schema switch
// and grid.ts's cross-schema FK navigation, which then diverge on what
// resets afterward.
export function setSchema(name: string): void {
  state.schema = name;
  $<HTMLSelectElement>("schema-select").value = name;
  rememberSchema();
}

// #source-select onchange: a different source can have a completely
// different schema list and table set, so nothing about the previous
// source's view carries over — except the schema last used on this source,
// which loadSchemas() still validates and falls back from if it's gone.
export function switchSource(name: string): void {
  state.source = name;
  state.schema = state.schemaBySource[name] ?? null;
  state.table = null;
  state.sort = null;
  state.offset = 0;
  clearFilter();
  persist();
}

// #schema-select onchange: setSchema() plus the view reset a schema change
// implies (its table list and columns are different).
export function switchSchema(name: string): void {
  setSchema(name);
  state.table = null;
  state.sort = null;
  state.offset = 0;
  clearFilter();
}

// Sidebar table click: the filter was written against this table's columns
// so it clears; the sort is restored to whatever was last used on this table.
export function switchTable(name: string): void {
  state.table = name;
  state.offset = 0;
  applyStoredSort(name);
  clearFilter();
  persist();
}

// ---- new-rows-since-refresh bookkeeping ----
// scopeKey identifies "the same view" between two fetches: a sort/filter/page/
// scope change makes every row look new, so the highlight only fires when this
// is unchanged from the fetch being diffed against. The last payload and its
// scope key are held here because they are per-session mutable state, like the
// rest of this module; the diff itself is pure (lib/row-diff.ts).
export function scopeKey(): string {
  return JSON.stringify([
    state.source,
    state.schema,
    state.table,
    state.sort,
    state.order,
    state.offset,
    state.limit,
    getAppliedFilterAst(),
  ]);
}

let lastPayload: TableData | null = null;
export function getLastPayload(): TableData | null {
  return lastPayload;
}

let lastScopeKey: string | null = null;

// Advances the lastPayload/lastScopeKey bookkeeping, since it only ever happens
// alongside this diff.
export function diffNewRows(data: TableData, highlightNew: boolean): { newRowKeys?: Set<string>; pkNames: string[] } {
  const nowScope = scopeKey();
  const result = collectNewRowKeys(lastPayload, data, {
    highlightNew,
    sameScope: lastScopeKey === nowScope,
  });
  lastPayload = data;
  lastScopeKey = nowScope;
  return result;
}
