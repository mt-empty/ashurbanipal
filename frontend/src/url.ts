import { restoreFilterFromParams, restoreFromStorage, state } from "./store.js";

// URL <-> state, read side (nav.ts owns the write side, syncUrl). There are
// two readers and they differ on purpose:
//
//   applyUrlOverlay  — load time. Only fields the URL actually names are
//                      touched; the rest keep whatever restoreFromStorage()
//                      left, so a bare visit uses saved prefs and a shared
//                      link layers its view on top.
//   applyUrlExact    — popstate. Every field is set from this history
//                      entry, reproducing it verbatim — an absent param
//                      means "was not set here", i.e. cleared, not kept.
//
// Do not merge them into one pass: an absent param means opposite things to
// each (keep vs. clear), and collapsing that silently breaks back/forward
// with no test failing.

export function applyUrlOverlay(params: URLSearchParams): void {
  if (params.has("source")) state.source = params.get("source");
  if (params.has("schema")) state.schema = params.get("schema");
  if (params.has("table")) state.table = params.get("table");
  if (params.has("sort")) state.sort = params.get("sort");
  if (params.has("order")) state.order = params.get("order") === "desc" ? "desc" : "asc";
  if (params.has("limit")) state.limit = Number(params.get("limit")) || state.limit;
  if (params.has("offset")) state.offset = Number(params.get("offset")) || 0;
  restoreFilterFromParams(params);
}

export function applyUrlExact(params: URLSearchParams): void {
  state.source = params.get("source") || null;
  state.schema = params.get("schema") || null;
  state.table = params.get("table") || null;
  state.sort = params.get("sort") || null;
  state.order = params.get("order") === "desc" ? "desc" : "asc";
  state.limit = Number(params.get("limit")) || state.limit;
  state.offset = Number(params.get("offset")) || 0;
  restoreFilterFromParams(params);
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
  return params.size ? `?${params}` : "";
}

// `api/schemas` (spec/protocol.md §5.7) takes `source` but not `schema` —
// it's what resolves schema in the first place — so it gets its own query
// builder rather than scopeQuery()'s combined source+schema.
export function sourceQuery(): string {
  return state.source ? `?${new URLSearchParams({ source: state.source })}` : "";
}

// Called once, first thing in main.ts's bootstrap: stored prefs, then the
// URL layered over them.
export function initState(): void {
  restoreFromStorage();
  applyUrlOverlay(new URLSearchParams(location.search));
}
