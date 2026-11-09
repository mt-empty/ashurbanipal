import { scopeParams } from "../lib/table-ref.js";
import { dropRetiredKeys } from "./storage.js";
import {
  chosenScope,
  restoreFilterFromParams,
  restoreFromStorage,
  restoreJoinFromParams,
  scopeOnSource,
  startTable,
  state,
  tableView,
  type ViewRequest,
  withSchema,
} from "./store.js";
import type { SchemaRef, View } from "./types.js";
import { recordUrlIntent } from "./url-intent.js";

// URL <-> state, read side (view-history.ts owns the write side, syncUrl).
// There are two readers and they differ on purpose:
//
//   applyUrlOverlay  — load time. Only fields the URL actually names are
//                      touched; the rest keep whatever restoreFromStorage()
//                      left, so a bare visit uses saved prefs and a shared
//                      link layers its view on top.
//   applyUrlExact    — popstate. Every field is set from this history
//                      entry, reproducing it verbatim — an absent param
//                      means "was not set here", i.e. cleared, not kept.
//                      Except source and schema: the URL leaves one out only
//                      when there is no other to choose (applyUrlScope), so
//                      an absent one keeps the current name.
//
// Do not merge them into one pass: an absent param means opposite things to
// each (keep vs. clear), and collapsing that silently breaks back/forward
// with no test failing.

export function applyUrlOverlay(params: URLSearchParams): void {
  // Names to try; an empty `?source=` asks for nothing in particular. A link
  // to another source without a schema tries that source's own last schema.
  const stored = state.scope;
  const source = params.has("source") ? params.get("source") || null : stored.source;
  if (params.has("schema")) state.scope = { kind: "loading", source, schema: params.get("schema") || null };
  else if (source !== stored.source) state.scope = scopeOnSource(source);
  else state.scope = { kind: "loading", source, schema: stored.schema };
  if (params.has("table")) state.view = tableView(params.get("table"));
  if (params.has("sort")) state.sort = params.get("sort");
  if (params.has("order")) state.order = params.get("order") === "desc" ? "desc" : "asc";
  if (params.has("limit")) state.limit = Number(params.get("limit")) || state.limit;
  if (params.has("offset")) state.offset = Number(params.get("offset")) || 0;
  restoreJoinFromParams(params);
  restoreFilterFromParams(params);
}

export function applyUrlExact(params: URLSearchParams): void {
  const current = state.scope.source;
  const source = params.get("source") || current;
  const schema = params.get("schema");
  if (source === current) {
    if (schema) state.scope = withSchema(state.scope, schema);
  } else {
    // Another source is checked by loadSchemas, as on a switch; never with this source's schema.
    state.scope = scopeOnSource(source, schema || null);
  }
  state.view = tableView(params.get("table"));
  state.sort = params.get("sort") || null;
  state.order = params.get("order") === "desc" ? "desc" : "asc";
  state.limit = Number(params.get("limit")) || state.limit;
  state.offset = Number(params.get("offset")) || 0;
  restoreJoinFromParams(params);
  restoreFilterFromParams(params);
}

// A data request's query, shared by the load itself and every prefetch of it so
// the two build the same path. A join's sort and `join` value are the caller's.
// `scope` is the request's schema: a table view's own, a join's default.
export function dataParams(req: ViewRequest, scope: SchemaRef): URLSearchParams {
  const { view, sort } = req;
  const params = new URLSearchParams({ limit: String(state.limit), offset: String(req.offset) });
  if (view.kind === "table") {
    params.set("table", view.table);
    if (sort) {
      params.set("sort", sort);
      params.set("order", req.order);
    }
  }
  scopeParams(scope, params);
  // The wire format is the JSON AST (spec/protocol.md §5.4.2), never the
  // box's DSL text — URLSearchParams handles the URL-encoding.
  if (req.filter) params.set("filter", JSON.stringify(req.ast));
  return params;
}

export function tableDataPath(req: ViewRequest, scope: SchemaRef): string {
  return `/tables/data?${dataParams(req, scope)}`;
}

// Not a SchemaRef: a name left out here is one the page had no choice of.
function applyUrlScope(params: URLSearchParams): void {
  const { source, schema } = chosenScope();
  if (source) params.set("source", source);
  if (schema) params.set("schema", schema);
}

// The params that name a view, shared by syncUrl and chip links.
export function viewParams(view: View | null): URLSearchParams {
  const params = new URLSearchParams({ table: startTable(view) ?? "" });
  applyUrlScope(params);
  if (view?.kind === "join") params.set("join", view.text);
  return params;
}

// A chip's href. Paging, sort and filter are left out: a fresh tab takes them
// from stored prefs, the same way an in-place switch does.
export function viewHref(view: View): string {
  return `?${viewParams(view)}`;
}

// `api/schemas` (spec/protocol.md §5.7) takes `source` but not `schema` —
// it's what resolves schema in the first place — so it gets its own query
// builder rather than lib/table-ref.ts scopeQuery()'s source and schema.
export function sourceQuery(): string {
  const { source } = state.scope;
  return source ? `?${new URLSearchParams({ source })}` : "";
}

// Called once, first thing in main.ts's bootstrap: stored prefs, then the
// URL layered over them.
export function initState(): void {
  const params = new URLSearchParams(location.search);
  dropRetiredKeys();
  restoreFromStorage();
  recordUrlIntent(params);
  applyUrlOverlay(params);
}
