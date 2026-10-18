import { tryParseFilterDsl } from "../lib/filter-dsl.js";
import { effectiveName, parseJoin, printJoin } from "../lib/join-dsl.js";
import { collectNewRowKeys } from "../lib/row-diff.js";
import { $ } from "./dom.js";
import type { FilterCondition, JoinDef, JoinView, TableData, TableView, View } from "./types.js";

const UI_KEY = "ashurbanipal_ui";

export interface State {
  source: string | null;
  schema: string | null;
  // null until a table is chosen. Changed through the transitions below.
  view: View | null;
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

// Persisted to localStorage and mirrored to the URL: the view's table (a join
// view's start table), limit/offset directly, sort/order keyed per table. filter is the one exception — it
// goes in the URL (a link is already the shareable-view surface) but never
// to localStorage (so returning to a table later never silently reapplies
// a filter this visit didn't type — ui-guidelines R6). state.filter is the
// *applied* filter, decoupled from the live #filter input text — only
// committing (submit, a click-to-filter action, or a URL restore) updates
// it, so an unfinished edit never gets silently resent by an unrelated
// sort/page click.
//
// Feature modules mutate scope through the named transitions below
// (switchSource / switchSchema / switchTable / clearJoin, and joinRequest +
// commitRequest for a new join), not by assigning fields ad hoc; the one sanctioned divergence is nav.ts's
// navigateWithSeededFilter (FK-cell nav and the referenced-by drill-in),
// which seeds a filter rather than clearing one.
export const state: State = {
  source: null,
  schema: null,
  view: null,
  sort: null,
  order: "asc",
  limit: 50,
  offset: 0,
  hiddenColumns: {},
  sortByTable: {},
  schemaBySource: {},
  filter: "",
};

// "" is no table: an empty `table=` in the URL or storage means nothing is chosen.
export function tableView(name: string | null | undefined): TableView | null {
  return name ? { kind: "table", table: name } : null;
}

// Hidden columns survive only while the same join stays in view.
function joinView(def: JoinDef, previous: View | null): JoinView {
  const text = printJoin(def);
  const hidden = previous?.kind === "join" && previous.text === text ? previous.hidden : [];
  return { kind: "join", def, text, hidden };
}

// The table a view is rooted on: a join's start table. For the URL, storage and
// per-scope keys; per-table requests use tableInView().
export function startTable(view: View): string;
export function startTable(view: View | null): string | null;
export function startTable(view: View | null): string | null {
  if (view === null) return null;
  switch (view.kind) {
    case "table":
      return view.table;
    case "join":
      return view.def.tables[0].table;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export function viewKey(view: View | null): string {
  if (view === null) return "";
  return view.kind === "table" ? `table:${view.table}` : `join:${view.text}`;
}

// The one table in view, or null in a join view (which has several) or before one is chosen.
export function tableInView(): string | null {
  return state.view?.kind === "table" ? state.view.table : null;
}

export function joinInView(): JoinView | null {
  return state.view?.kind === "join" ? state.view : null;
}

// Table aliases in position order, the shape parseFilterDsl takes in a join view.
export function joinAliases(): string[] | undefined {
  return joinInView()?.def.tables.map(effectiveName);
}

function enterJoin(def: JoinDef): void {
  state.view = joinView(def, state.view);
}

// Every move to a table view. Leaving a join drops the sort and filter written
// against its `alias.column` labels, which the table would reject.
export function showTable(name: string | null): void {
  if (state.view?.kind === "join") {
    state.sort = null;
    state.order = "asc";
    clearFilter();
  }
  state.view = tableView(name);
}

// To the join's start table, as a table chip would open it.
export function clearJoin(): void {
  const join = joinInView();
  if (!join) return;
  const table = startTable(join);
  showTable(table);
  state.offset = 0;
  applyStoredSort(table);
}

// Runs after url.ts sets the table view and before the filter restore, which
// needs the aliases; malformed text leaves the table view (R5).
export function restoreJoinFromParams(params: URLSearchParams): void {
  const text = params.get("join") ?? "";
  const parsed = text ? parseJoin(text) : null;
  if (parsed && !("error" in parsed)) enterJoin(parsed.def);
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

// One load's view and query. A new join travels as one of these and becomes the
// state only once its data arrives, so a refused or failed join changes nothing.
export interface ViewRequest {
  readonly view: View;
  readonly sort: string | null;
  readonly order: "asc" | "desc";
  readonly offset: number;
  readonly filter: string;
  readonly ast: readonly FilterCondition[];
}

export function currentRequest(): ViewRequest | null {
  const { view, sort, order, offset, filter } = state;
  return view && { view, sort, order, offset, filter, ast: appliedFilterAst };
}

// A new join starts from the default view: the sort and filter were written
// against other columns. The join already in view (saved or renamed) keeps them.
export function joinRequest(def: JoinDef): ViewRequest {
  const view = joinView(def, state.view);
  const current = currentRequest();
  if (current && viewKey(current.view) === viewKey(view)) return { ...current, view };
  return { view, sort: null, order: "asc", offset: 0, filter: "", ast: [] };
}

export function commitRequest(r: ViewRequest): void {
  ({ view: state.view, sort: state.sort, order: state.order, offset: state.offset, filter: state.filter } = r);
  appliedFilterAst = [...r.ast];
  $<HTMLInputElement>("filter").value = r.filter;
  persist();
}

// The view the grid last rendered. A view set straight from a link or history
// that the server refused has never been shown.
let shownKey: string | null = null;
export function markViewShown(): void {
  shownKey = viewKey(state.view);
}
export function viewIsShown(): boolean {
  return shownKey === viewKey(state.view);
}

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
  const ast = text ? tryParseFilterDsl(text, joinAliases()) : null;
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
    if (typeof saved.table === "string") state.view = tableView(saved.table);
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
  const { source, schema, limit, hiddenColumns, sortByTable, schemaBySource } = state;
  const table = startTable(state.view);
  // Best-effort: a throw here (quota, private mode) must not abort the caller,
  // which almost always follows persist() with a loadData()/loadTables() the
  // user still needs. Unlike the single-string write in theme.ts, this
  // blob grows per table/source touched, so a quota
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
export function hiddenColumns(): readonly string[] {
  const view = state.view;
  if (view === null) return [];
  switch (view.kind) {
    case "table":
      return state.hiddenColumns[view.table] ?? [];
    case "join":
      return view.hidden;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

// A table's hidden columns are persisted; a join's last only while it stays in view.
export function setHiddenColumns(next: readonly string[]): void {
  const view = state.view;
  if (view === null) return;
  switch (view.kind) {
    case "table":
      if (next.length) state.hiddenColumns[view.table] = [...next];
      else delete state.hiddenColumns[view.table];
      persist();
      return;
    case "join":
      state.view = { ...view, hidden: next };
      return;
    default: {
      const _exhaustive: never = view;
    }
  }
}

// sort + order are remembered per table (like hiddenColumns): a column
// name is table-specific, so this never carries a sort across tables.
export function rememberSort(): void {
  const table = tableInView();
  if (!table) return;
  if (state.sort) state.sortByTable[table] = { col: state.sort, order: state.order };
  else delete state.sortByTable[table];
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
export function dropOneStaleInput(code: string | undefined): boolean {
  // An applied filter that already survived a fetch was typed on this visit,
  // so the 400 is the user's to see — it suppresses the whole ladder rather
  // than being silently discarded.
  if (state.filter !== "" && !filterRisk.isUnverified()) return false;
  // A sort can break the query itself (a 500 on a type the engine cannot
  // order); a timeout or a problem with the join or table is no sign against it.
  if (sortRisk.isUnverified() && state.view && !NOT_THE_INPUTS.has(code ?? "")) {
    dropStoredSort(tableInView());
    return true;
  }
  if (filterRisk.isUnverified() && FILTER_FAULTS.has(code ?? "")) {
    clearFilter();
    return true;
  }
  return false;
}
const NOT_THE_INPUTS = new Set(["query_timeout", "invalid_join", "not_readable"]);
const FILTER_FAULTS = new Set(["unknown_column", "invalid_filter", "invalid_parameter"]);

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
// Each of the three scope switches (source, schema, table) has exactly one caller, so they take
// no options. nav.ts's navigateWithSeededFilter is the sanctioned bypass —
// it seeds a filter rather than clearing one, drops the remembered sort (a
// stale one would defeat loadData's drop-and-retry against the same-fetch
// filter), and lets submitFilter own the offset reset.

// Pins state.schema to a concrete name and syncs the #schema-select value +
// the per-source memory (R12). The step shared by an explicit schema switch
// and navigateWithSeededFilter's cross-schema path, which then diverge on
// what resets afterward.
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
  showTable(null);
  state.sort = null;
  state.offset = 0;
  clearFilter();
  persist();
}

// #schema-select onchange: setSchema() plus the view reset a schema change
// implies (its table list and columns are different).
export function switchSchema(name: string): void {
  setSchema(name);
  showTable(null);
  state.sort = null;
  state.offset = 0;
  clearFilter();
}

// Table chip click: the filter was written against this table's columns
// so it clears; the sort is restored to whatever was last used on this table.
export function switchTable(name: string): void {
  showTable(name);
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
    viewKey(state.view),
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
