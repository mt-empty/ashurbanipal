import { $, reportError } from "./dom.js";
import { loadTables } from "./sidebar.js";
import { applyScopeParams, persist, restoreFilterFromParams, state } from "./state.js";

// Back/forward navigation stops at table/schema/source switches, not every
// sort/page tweak within the same table — otherwise "back" would undo
// pagination one row-page at a time instead of returning to the previously
// viewed table.
// navStack mirrors the browser's own session-history entries we've pushed
// (their order, not their content) so the in-app buttons know when they're
// at either end; the entries themselves live in the URL/history.state, never
// duplicated into a JS-held array of visited data.
let navStack: string[] = [];
let navIndex = -1;
let restoringFromHistory = false; // true while a popstate-triggered reload is in flight

function navViewKey(): string {
  return `${state.source ?? ""} ${state.schema ?? ""} ${state.table ?? ""}`;
}

function updateNavButtons(): void {
  $<HTMLButtonElement>("nav-back").disabled = navIndex <= 0;
  $<HTMLButtonElement>("nav-forward").disabled = navIndex >= navStack.length - 1;
}

// filter rides in the URL (ui-guidelines.md R6) but is deliberately excluded
// from navViewKey() below — a filter change replaces the current history
// entry like a sort click or a page turn, never pushing a new back-stack stop.
export function syncUrl(): void {
  const params = new URLSearchParams({
    table: state.table ?? "", limit: String(state.limit), offset: String(state.offset),
  });
  if (state.sort) { params.set("sort", state.sort); params.set("order", state.order); }
  applyScopeParams(params);
  if (state.filter) params.set("filter", state.filter);
  const qs = "?" + params;
  const key = navViewKey();
  const samePlace = navIndex >= 0 && navStack[navIndex] === key;
  if (restoringFromHistory || navStack.length === 0 || samePlace) {
    if (navStack.length === 0) { navStack = [key]; navIndex = 0; }
    history.replaceState({ navIndex }, "", qs);
  } else {
    navStack = navStack.slice(0, navIndex + 1);
    navStack.push(key);
    navIndex = navStack.length - 1;
    history.pushState({ navIndex }, "", qs);
  }
  updateNavButtons();
}

window.addEventListener("popstate", (ev) => {
  const navState = ev.state as { navIndex?: number } | null;
  if (!navState || typeof navState.navIndex !== "number") return;
  if (navState.navIndex < 0 || navState.navIndex >= navStack.length) return;
  navIndex = navState.navIndex;
  const params = new URLSearchParams(location.search);
  state.source = params.get("source") || null;
  state.schema = params.get("schema") || null;
  state.table = params.get("table") || null;
  state.sort = params.get("sort") || null;
  state.order = params.get("order") === "desc" ? "desc" : "asc";
  state.limit = Number(params.get("limit")) || state.limit;
  state.offset = Number(params.get("offset")) || 0;
  restoreFilterFromParams(params);
  const sourceSelect = $<HTMLSelectElement>("source-select");
  if (sourceSelect) sourceSelect.value = state.source ?? "";
  const schemaSelect = $<HTMLSelectElement>("schema-select");
  if (schemaSelect) schemaSelect.value = state.schema ?? "";
  // syncUrl() only ever writes `schema` when the source at that history
  // point had more than one (loadSchemas pins state.schema to a concrete
  // name only then) — its presence/absence here is a reliable proxy for
  // this restored source's schema count, without a live re-fetch.
  $("schema-select-wrap").hidden = !state.schema;
  persist();
  updateNavButtons();
  restoringFromHistory = true;
  loadTables()
    .catch(reportError)
    .finally(() => { restoringFromHistory = false; });
});
