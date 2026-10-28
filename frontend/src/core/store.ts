import { tryParseFilterDsl } from "../lib/filter-dsl.js";
import { effectiveName, parseJoin, printJoin } from "../lib/join-dsl.js";
import { collectNewRowKeys } from "../lib/row-diff.js";
import { isScopeKey, scopeKey, visitKey } from "../lib/scope-key.js";
import { $ } from "./dom.js";
import { readStored, writeStored } from "./storage.js";
import type { FilterCondition, JoinDef, JoinView, Scope, TableView, View, ViewData } from "./types.js";

const UI_KEY = "ashurbanipal_view";

export interface State {
  scope: Scope;
  // Whether /sources and /schemas list more than one name: the URL names only
  // a choice there was (url.ts applyUrlScope).
  manySources: boolean;
  manySchemas: boolean;
  // /schemas reported no default, so a table name only resolves with its schema.
  noDefaultSchema: boolean;
  // null until a table is chosen. Changed through the transitions below.
  view: View | null;
  sort: string | null;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  // Keyed by knownScopeKey(table), like sortByTable.
  hiddenColumns: Record<string, string[]>;
  // sort/order remembered per table, so returning to a table restores the
  // sort last chosen there (what lets the refresh button surface new rows
  // without re-sorting each visit — ui-guidelines R10/R11).
  sortByTable: Record<string, { col: string; order: "asc" | "desc" }>;
  // Schema is query scope like sort is, remembered per source so flipping
  // sources and back doesn't drop you into the source's default again (ui-guidelines R12).
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
// (switchSource / switchSchema / clearJoin), or build a request (tableRequest,
// joinRequest) that commitRequest applies once its data arrives; never by
// assigning fields ad hoc. view-history.ts's navigateWithSeededFilter builds its own
// request, seeding a filter rather than clearing one.
export const state: State = {
  scope: { kind: "loading", source: null, schema: null },
  manySources: false,
  manySchemas: false,
  noDefaultSchema: false,
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
export function enterTable(name: string | null): void {
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
  enterTable(table);
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

// One load's view and query. A new table or join travels as one of these and
// becomes the state only once its data arrives, so a refused or failed switch
// changes nothing.
export interface ViewRequest {
  readonly view: View;
  readonly sort: string | null;
  readonly order: "asc" | "desc";
  readonly offset: number;
  readonly filter: string;
  readonly ast: readonly FilterCondition[];
  // The sort came from storage, so a refusal may be its fault (R11).
  readonly restoredSort?: boolean;
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

// Table chip click: the filter was written against the previous table's
// columns so it clears; the sort is the one last used on this table.
export function tableRequest(name: string): ViewRequest {
  const stored = tableEntry(state.sortByTable, name);
  return {
    view: { kind: "table", table: name },
    sort: stored?.col ?? null,
    order: stored?.order ?? "asc",
    offset: 0,
    filter: "",
    ast: [],
    restoredSort: stored !== undefined,
  };
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

// The key for anything remembered per scope: null until start-up has checked
// both names against the lists, or after a lookup failed, so nothing is
// remembered under a guessed scope.
export function knownScopeKey(...rest: string[]): string | null {
  return state.scope.kind === "known" ? scopeKey(state.scope.source, state.scope.schema, ...rest) : null;
}

// Tells one scope (and, with `rest`, a table in it) from another within this
// visit, resolved or not; for per-visit caches, never stored.
export function scopeIdentity(...rest: string[]): string {
  return visitKey(state.scope.source, state.scope.schema, ...rest);
}

// The names the page URL carries: only where there was a choice, so a link
// stays short and opens on a sibling whose one source has another name.
export function chosenScope(): { source: string | null; schema: string | null } {
  return {
    source: state.manySources ? state.scope.source : null,
    schema: state.manySchemas ? state.scope.schema : null,
  };
}

// A table name as the user would type it in SQL: schema-qualified only where
// the bare name could mean another schema's table, or none.
export function qualifiedTable(table: string): string {
  const { schema } = state.scope;
  return schema && (state.manySchemas || state.noDefaultSchema) ? `${schema}.${table}` : table;
}

// A table's name only means one table within its source and schema, so the
// per-table maps are keyed by all three, and stay untouched while the scope
// is not known.
function tableEntry<T>(map: Record<string, T>, table: string): T | undefined {
  const key = knownScopeKey(table);
  return key === null ? undefined : map[key];
}

// `undefined` deletes the entry.
function setTableEntry<T>(map: Record<string, T>, table: string, value: T | undefined): void {
  const key = knownScopeKey(table);
  if (key === null) return;
  if (value === undefined) delete map[key];
  else map[key] = value;
}

// Restores the persisted view (never the filter — ui-guidelines R6). A
// malformed blob is discarded wholesale rather than migrated: it is cheap to
// lose and there is no reliable way to guess what it meant. url.ts's
// initState() runs this before layering the URL over it.
export function restoreFromStorage(): void {
  try {
    const saved = JSON.parse(readStored(UI_KEY) || "{}");
    const name = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    state.scope = { kind: "loading", source: name(saved.source), schema: name(saved.schema) };
    if (typeof saved.table === "string") state.view = tableView(saved.table);
    // isFinite, not just typeof: a corrupted NaN/Infinity is still type
    // "number" but breaks the pager arithmetic in grid.ts that divides by it.
    if (typeof saved.limit === "number" && Number.isFinite(saved.limit)) state.limit = saved.limit;
    // Keyed per table so hiding a column on one table never hides a
    // same-named column on another. A key not shaped [source, schema, table]
    // is dropped, so the next persist() removes it.
    if (isPlainObject(saved.hiddenColumns)) {
      for (const [key, cols] of Object.entries(saved.hiddenColumns)) {
        if (!isScopeKey(key, 3) || !Array.isArray(cols)) continue;
        const clean = cols.filter((c) => typeof c === "string");
        if (clean.length) state.hiddenColumns[key] = clean;
      }
    }
    if (isPlainObject(saved.sortByTable)) {
      for (const [key, v] of Object.entries(saved.sortByTable)) {
        if (isScopeKey(key, 3) && isPlainObject(v) && typeof v.col === "string") {
          state.sortByTable[key] = { col: v.col, order: v.order === "desc" ? "desc" : "asc" };
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
    // reverts the view to defaults with no trace.
    console.warn("ashurbanipal: discarding unreadable view state", e);
    writeStored(UI_KEY, null);
  }
}

export function persist(): void {
  const { limit, hiddenColumns, sortByTable, schemaBySource } = state;
  const { source, schema } = state.scope;
  const table = startTable(state.view);
  // The caller almost always follows persist() with a loadData()/loadTables()
  // the user still needs. This blob grows per table/source touched, so a quota
  // failure is plausible on a long session — warn so it isn't wholly invisible.
  writeStored(
    UI_KEY,
    JSON.stringify({ source, schema, table, limit, hiddenColumns, sortByTable, schemaBySource }),
    "ashurbanipal: could not persist view state",
  );
}

// Names of columns no longer in view are dropped after each load
// (pruneHiddenColumns), so they never count as hidden.
export function hiddenColumns(): readonly string[] {
  const view = state.view;
  if (view === null) return [];
  switch (view.kind) {
    case "table":
      return tableEntry(state.hiddenColumns, view.table) ?? [];
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
      setTableEntry(state.hiddenColumns, view.table, next.length ? [...next] : undefined);
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

// A column renamed or dropped since it was hidden would otherwise count as
// hidden forever, with no checkbox left to show it again.
export function pruneHiddenColumns(live: readonly string[]): void {
  const current = hiddenColumns();
  const names = new Set(live);
  const kept = current.filter((c) => names.has(c));
  if (kept.length !== current.length) setHiddenColumns(kept);
}

// sort + order are remembered per table (like hiddenColumns): a column
// name is table-specific, so this never carries a sort across tables.
export function rememberSort(): void {
  const table = tableInView();
  if (!table) return;
  setTableEntry(state.sortByTable, table, state.sort ? { col: state.sort, order: state.order } : undefined);
  sortRisk.set(false); // came from a click on a live header
  persist();
}

// Sets the active sort from what's stored for `table` (or clears it).
export function applyStoredSort(table: string | null): void {
  const stored = table ? tableEntry(state.sortByTable, table) : undefined;
  state.sort = stored?.col ?? null;
  state.order = stored?.order ?? "asc";
  sortRisk.set(state.sort !== null);
}

// The backend rejected a restored sort column (400). Drop it so the caller
// can retry unsorted (ui-guidelines R5).
function dropStoredSort(table: string | null): void {
  if (table) setTableEntry(state.sortByTable, table, undefined);
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

// The same ladder's sort step for a request not yet in view: its stored sort
// is forgotten and the request retried without it.
export function dropStaleSort(req: ViewRequest, code: string | undefined): ViewRequest | null {
  if (!req.restoredSort || NOT_THE_INPUTS.has(code ?? "")) return null;
  setTableEntry(state.sortByTable, startTable(req.view), undefined);
  persist();
  return { ...req, sort: null, order: "asc", restoredSort: false };
}
const FILTER_FAULTS = new Set(["unknown_column", "invalid_filter", "invalid_parameter"]);

// Records the active schema against the current source (ui-guidelines R12),
// so #source-select's onchange can restore it instead of resetting to the
// source's default. Only a schema switch records one, so a single-schema
// source never gets an entry.
export function rememberSchema(): void {
  if (state.scope.kind === "known") state.schemaBySource[state.scope.source] = state.scope.schema;
  persist();
}

// The scope to try on `source`: `schema` when one is named, else the schema
// last used there (R12), which loadSchemas still checks. Source names are host
// data, so an inherited key like `constructor` must not read as one.
export function scopeOnSource(source: string | null, schema: string | null = null): Scope {
  const remembered = source !== null && Object.hasOwn(state.schemaBySource, source);
  return { kind: "loading", source, schema: schema ?? (remembered ? state.schemaBySource[source] : null) };
}

// The scope with its schema replaced by a concrete name; a known source makes it known.
export function withSchema(scope: Scope, schema: string): Scope {
  return scope.source === null
    ? { kind: "failed", source: null, schema }
    : { kind: "known", source: scope.source, schema };
}

// loadSources' result: the listed source to use, or null when /sources failed.
// The schema stays a name to try until loadSchemas checks it.
export function settleSource(source: string | null, many: boolean): void {
  const { schema } = state.scope;
  state.scope = source === null ? { kind: "failed", source, schema } : { kind: "loading", source, schema };
  state.manySources = many;
}

// loadSchemas' result: the listed schema to use, or null when /schemas failed
// or listed none.
export function settleSchema(schema: string | null, many: boolean, noDefault: boolean): void {
  state.scope =
    schema === null ? { kind: "failed", source: state.scope.source, schema } : withSchema(state.scope, schema);
  state.manySchemas = many;
  state.noDefaultSchema = noDefault;
}

// ---- named scope transitions ----
// Each scope switch (source, schema) has exactly one caller, so they take
// no options.

// Pins the scope's schema to a concrete name and syncs the #schema-select value +
// the per-source memory (R12). The step shared by an explicit schema switch
// and navigateWithSeededFilter's cross-schema path, which then diverge on
// what resets afterward.
export function setSchema(name: string): void {
  state.scope = withSchema(state.scope, name);
  $<HTMLSelectElement>("schema-select").value = name;
  rememberSchema();
}

// #source-select onchange: a different source can have a completely
// different schema list and table set, so nothing about the previous
// source's view carries over — except the schema last used on this source,
// which loadSchemas() still validates and falls back from if it's gone.
export function switchSource(name: string): void {
  state.scope = scopeOnSource(name);
  enterTable(null);
  state.sort = null;
  state.offset = 0;
  clearFilter();
  persist();
}

// #schema-select onchange: setSchema() plus the view reset a schema change
// implies (its table list and columns are different).
export function switchSchema(name: string): void {
  setSchema(name);
  enterTable(null);
  state.sort = null;
  state.offset = 0;
  clearFilter();
}

// ---- new-rows-since-refresh bookkeeping ----
// rowDiffKey identifies "the same view" between two fetches: a sort/filter/page/
// scope change makes every row look new, so the highlight only fires when this
// is unchanged from the fetch being diffed against. The last payload and its
// key are held here because they are per-session mutable state, like the
// rest of this module; the diff itself is pure (lib/row-diff.ts).
function rowDiffKey(): string {
  return JSON.stringify([
    scopeIdentity(),
    viewKey(state.view),
    state.sort,
    state.order,
    state.offset,
    state.limit,
    getAppliedFilterAst(),
  ]);
}

let lastPayload: ViewData | null = null;
export function getLastPayload(): ViewData | null {
  return lastPayload;
}

let lastRowDiffKey: string | null = null;

// Advances the lastPayload/lastRowDiffKey bookkeeping, since it only ever happens
// alongside this diff.
export function diffNewRows(data: ViewData, highlightNew: boolean): { newRowKeys?: Set<string>; pkNames: string[] } {
  const nowScope = rowDiffKey();
  const result = collectNewRowKeys(lastPayload, data, {
    highlightNew,
    sameScope: lastRowDiffKey === nowScope,
  });
  lastPayload = data;
  lastRowDiffKey = nowScope;
  return result;
}
