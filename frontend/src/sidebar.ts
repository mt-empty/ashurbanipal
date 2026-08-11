import { api } from "./api.js";
import { $, setStatus } from "./dom.js";
import { loadData } from "./main.js";
import { persist, schemaQuery, setAppliedFilterAst, state } from "./state.js";
import type { TableListEntry } from "./types.js";

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

// ==== Schema selector ====
// Hidden entirely for a single-schema deployment (the overwhelming common
// case) — no dropdown clutter, and no `schema` param on any request, byte-
// for-byte the same wire shape as before schema selection existed. Once a
// second schema is confirmed, state.schema is pinned to a concrete name
// (never left as "no explicit choice") so every subsequent request is
// unambiguous about which schema it means.
export async function loadSchemas(): Promise<void> {
  let schemas: string[];
  try {
    ({ schemas } = await api<{ schemas: string[] }>("/schemas"));
  } catch {
    return; // older port without /schemas — degrade to single-schema behavior
  }
  if (schemas.length <= 1) { state.schema = null; return; }
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
  state.filter = ""; setAppliedFilterAst([]); $<HTMLInputElement>("filter").value = "";
  persist();
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
    api<{ tables: TableListEntry[] }>("/tables" + schemaQuery()),
    api<{ counts: { table: string; approx_rows: number }[] }>("/table-counts" + schemaQuery()),
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
    // A filter clause is written against this table's columns, so it
    // resets on table switch the same way sort already does.
    btn.onclick = () => {
      state.table = t.name; state.offset = 0; state.sort = null;
      state.filter = ""; setAppliedFilterAst([]);
      $<HTMLInputElement>("filter").value = "";
      persist(); loadData();
    };
    li.appendChild(btn);
    ul.appendChild(li);
    tableEntries.push({ name: t.name, li, btn, textNode: btn.firstChild!.firstChild as Text });
  }
  filterTables();
  const tableNames = tables.map((t) => t.name);
  // Stale persisted state must never wedge the UI: fall back silently.
  if (!tableNames.includes(state.table ?? "")) state.table = tableNames[0] ?? null;
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
