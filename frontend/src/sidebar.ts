import { api } from "./api.js";
import { $, setStatus } from "./dom.js";
import { loadData } from "./main.js";
import { applyStoredSort, clearFilter, persist, rememberSchema, scopeQuery, sourceQuery, state } from "./state.js";
import type { SourceEntry, TableListEntry } from "./types.js";

// approx_rows/total_approx is -1 when the backend has no cheap estimate for
// this table (e.g. Postgres before ANALYZE, or an engine with no such
// catalog at all — see docs/adapter-decisions.md); show "?" rather than a
// confusing raw negative number. No leading "~" in that case either —
// "~?" would read as "approximately unknown".
export function formatApproxCount(n: number | null | undefined): string {
  return n == null || n < 0 ? "?" : `~${n}`;
}
export const APPROX_COUNT_TITLE = "~ = approximate, from the backend's own statistics, not a live count; "
  + "? = no cheap estimate available (table not yet analyzed, or this backend keeps no such statistics)";

// ---- sidebar table search-as-you-type: transient, session-local state,
// not part of `state`/localStorage — resets on reload ----
interface TableEntry {
  name: string;
  li: HTMLLIElement;
  btn: HTMLButtonElement;
  textNode: Text;
}
let tableEntries: TableEntry[] = [];
const tableMatchHighlight = CSS.highlights ? new Highlight() : null;
if (tableMatchHighlight) CSS.highlights.set("table-match", tableMatchHighlight);

function filterTables(): void {
  const q = $<HTMLInputElement>("table-filter").value.trim().toLowerCase();
  tableMatchHighlight?.clear();
  let visible = 0;
  for (const { name, li, textNode } of tableEntries) {
    const idx = q ? name.toLowerCase().indexOf(q) : -1;
    const match = !q || idx !== -1;
    li.hidden = !match;
    if (match) visible++;
    if (tableMatchHighlight && idx !== -1) {
      const range = new Range();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + q.length);
      tableMatchHighlight.add(range);
    }
  }
  $("tables-empty").hidden = visible > 0 || tableEntries.length === 0;
}
$<HTMLInputElement>("table-filter").oninput = filterTables;

// ==== Source selector ====
// Same hide-when-singular shape as the schema selector below it (and drawn
// above it — source is the outer scope, schema resolves within a source).
// Switching source resets schema/table/sort/filter too: a different source
// can have a completely different schema list and table set, so nothing
// about the previous source's view carries over.
export async function loadSources(): Promise<void> {
  let sources: SourceEntry[];
  try {
    ({ sources } = await api<{ sources: SourceEntry[] }>("/sources"));
  } catch {
    return; // older port without /sources — degrade to single-source behavior
  }
  if (sources.length <= 1) { state.source = null; return; }
  if (!state.source || !sources.some((s) => s.name === state.source)) {
    state.source = sources[0]!.name;
  }
  const select = $<HTMLSelectElement>("source-select");
  select.replaceChildren(...sources.map((s) => {
    const opt = document.createElement("option");
    opt.value = s.name; opt.textContent = s.name;
    return opt;
  }));
  select.value = state.source!;
  $("source-select-wrap").hidden = false;
}
$<HTMLSelectElement>("source-select").onchange = () => {
  state.source = $<HTMLSelectElement>("source-select").value;
  // Restore the schema last used on this source rather than resetting;
  // loadSchemas() still validates it and falls back if it's gone (R5/R12).
  state.schema = state.schemaBySource[state.source ?? ""] ?? null;
  state.table = null; state.sort = null; state.offset = 0;
  clearFilter();
  persist();
  loadSchemas().then(loadTables).catch((e) => { $("error").textContent = e.message; });
};

// ==== Schema selector ====
// Hidden entirely for a single-schema deployment (the overwhelming common
// case) — no dropdown clutter, and no `schema` param on any request, byte-
// for-byte the same wire shape as before schema selection existed. Once a
// second schema is confirmed, state.schema is pinned to a concrete name
// (never left as "no explicit choice") so every subsequent request is
// unambiguous about which schema it means.
// Same supersession guard as loadTables: a slow /schemas from an earlier
// source switch resolving after a faster later one would otherwise clobber
// state.schema (and the selector) with the wrong source's schema set —
// worse now that #source-select restores a remembered schema rather than
// always resetting to a safe null.
let loadSchemasToken = 0;

export async function loadSchemas(): Promise<void> {
  const token = ++loadSchemasToken;
  let schemas: string[];
  try {
    ({ schemas } = await api<{ schemas: string[] }>("/schemas" + sourceQuery()));
  } catch {
    if (token !== loadSchemasToken) return;
    // older port without /schemas — degrade to single-schema behavior
    state.schema = null; $("schema-select-wrap").hidden = true; return;
  }
  if (token !== loadSchemasToken) return; // superseded by a newer source switch
  // Explicitly re-hides even though the element starts hidden in markup:
  // switching source can re-run this against a source with fewer schemas
  // than the previously selected one, and without this the wrap would keep
  // showing the prior source's stale multi-schema dropdown.
  if (schemas.length <= 1) { state.schema = null; $("schema-select-wrap").hidden = true; return; }
  if (!state.schema || !schemas.includes(state.schema)) {
    state.schema = schemas.includes("public") ? "public" : schemas[0];
  }
  const select = $<HTMLSelectElement>("schema-select");
  select.replaceChildren(...schemas.map((s) => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s;
    return opt;
  }));
  select.value = state.schema!;
  $("schema-select-wrap").hidden = false;
}
$<HTMLSelectElement>("schema-select").onchange = () => {
  state.schema = $<HTMLSelectElement>("schema-select").value;
  state.table = null; state.sort = null; state.offset = 0;
  clearFilter();
  rememberSchema();
  loadTables().catch((e) => { $("error").textContent = e.message; });
};

// A slower earlier loadTables() (e.g. from a schema switch quickly
// followed by another) resolving after a faster later one would otherwise
// clobber the sidebar with the wrong schema's table list — same shape of
// guard as loadDataToken/cvRequestToken/siblingsRequestToken.
let loadTablesToken = 0;

export async function loadTables(): Promise<void> {
  setStatus("loading tables…");
  const token = ++loadTablesToken;
  const [{ tables }, { counts }] = await Promise.all([
    api<{ tables: TableListEntry[] }>("/tables" + scopeQuery()),
    api<{ counts: { table: string; approx_rows: number }[] }>("/table-counts" + scopeQuery()),
  ]);
  if (token !== loadTablesToken) return; // superseded by a newer call
  const countMap = Object.fromEntries(counts.map((c) => [c.table, c.approx_rows]));
  const ul = $("tables");
  ul.innerHTML = "";
  tableEntries = [];
  for (const t of tables) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="row-name"></span><span class="row-right"><span class="row-spinner" aria-hidden="true"></span><span class="count"></span></span>`;
    (btn.firstChild as HTMLElement).textContent = t.name;
    const countEl = btn.querySelector<HTMLElement>(".count")!;
    countEl.textContent = formatApproxCount(countMap[t.name]);
    countEl.title = APPROX_COUNT_TITLE;
    btn.dataset.table = t.name;
    // Always set, not just when commented: long names get CSS-truncated
    // (see .row-name), so the title tooltip is the escape hatch.
    btn.title = t.comment ? `${t.name} — ${t.comment}` : t.name;
    // The filter is written against this table's columns, so it clears on
    // switch; the sort is restored to whatever was last used on this table.
    btn.onclick = () => {
      state.table = t.name; state.offset = 0; applyStoredSort(t.name);
      clearFilter();
      persist(); loadData();
    };
    li.appendChild(btn);
    ul.appendChild(li);
    tableEntries.push({ name: t.name, li, btn, textNode: btn.firstChild!.firstChild as Text });
  }
  filterTables();
  const tableNames = tables.map((t) => t.name);
  // Stale persisted state must never wedge the UI: fall back silently.
  if (!tableNames.includes(state.table ?? "")) {
    state.table = tableNames[0] ?? null;
    // A ?filter= was written against the table the URL named; that table
    // isn't here, so its columns can't apply to the fallback — carrying it
    // over would 400 and dead-end the very load meant to recover (R5).
    clearFilter();
  }
  // Restore this table's remembered sort unless one is already set — a
  // shared link's ?sort= or a history entry takes precedence.
  if (state.table && state.sort === null) applyStoredSort(state.table);
  // Awaited (not fire-and-forget): callers like nav.ts's popstate handler
  // reset restoringFromHistory once this promise settles, and that flag
  // must still be true when loadData()'s syncUrl() call runs, or a
  // history restoration would push a new entry instead of replacing it.
  if (state.table) await loadData();
  else setStatus("");
}

// Keyed by table name rather than "whichever row is .active" so it's
// still correct if tableEntries is ever rebuilt mid-fetch.
export function setRowLoading(name: string, loading: boolean): void {
  tableEntries.find((e) => e.name === name)?.btn.classList.toggle("loading", loading);
}
