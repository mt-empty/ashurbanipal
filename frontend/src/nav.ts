import { $ } from "./dom.js";
import { loadTables } from "./sidebar.js";
import { persist, setAppliedFilterAst, state } from "./state.js";

// Back/forward navigation stops at table/schema switches, not every sort/page
// tweak within the same table — otherwise "back" would undo pagination one
// row-page at a time instead of returning to the previously viewed table.
// navStack mirrors the browser's own session-history entries we've pushed
// (their order, not their content) so the in-app buttons know when they're
// at either end; the entries themselves live in the URL/history.state, never
// duplicated into a JS-held array of visited data.
let navStack: string[] = [];
let navIndex = -1;
let restoringFromHistory = false; // true while a popstate-triggered reload is in flight

function navViewKey(): string {
  return `${state.schema ?? ""} ${state.table ?? ""}`;
}

export function updateNavButtons(): void {
  $<HTMLButtonElement>("nav-back").disabled = navIndex <= 0;
  $<HTMLButtonElement>("nav-forward").disabled = navIndex >= navStack.length - 1;
}

// filter is never included (ui-guidelines.md R6) — applies to history.state
// exactly as it does to the URL and localStorage.
export function syncUrl(): void {
  const params = new URLSearchParams({
    table: state.table ?? "", limit: String(state.limit), offset: String(state.offset),
  });
  if (state.sort) { params.set("sort", state.sort); params.set("order", state.order); }
  if (state.schema) params.set("schema", state.schema);
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
  state.schema = params.get("schema") || null;
  state.table = params.get("table") || null;
  state.sort = params.get("sort") || null;
  state.order = params.get("order") === "desc" ? "desc" : "asc";
  state.limit = Number(params.get("limit")) || state.limit;
  state.offset = Number(params.get("offset")) || 0;
  state.filter = "";
  setAppliedFilterAst([]);
  $<HTMLInputElement>("filter").value = "";
  const schemaSelect = $<HTMLSelectElement>("schema-select");
  if (schemaSelect) schemaSelect.value = state.schema ?? "";
  persist();
  updateNavButtons();
  restoringFromHistory = true;
  loadTables()
    .catch((e) => { $("error").textContent = e.message; })
    .finally(() => { restoringFromHistory = false; });
});
