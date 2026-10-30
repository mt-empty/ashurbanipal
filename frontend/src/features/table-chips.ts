import { loadData } from "../bootstrap/reload.js";
import { api, prefetch } from "../core/api.js";
import { $, el, qs, setStatus } from "../core/dom.js";
import { type LoadReason, markTiming } from "../core/perf-marks.js";
import {
  applyStoredSort,
  clearFilter,
  enterTable,
  scopeIdentity,
  scopeQuery,
  startTable,
  state,
  tableDataPath,
  tableInView,
  tableRequest,
  type ViewRequest,
  viewHref,
} from "../core/state.js";
import { readStored, writeStored } from "../core/storage.js";
import type { TableListEntry } from "../core/types.js";
import { APPROX_COUNT_TITLE, formatApproxCount } from "../lib/format.js";
import { syncGridLock } from "./grid-lock.js";

// ---- table chips: transient, session-local state, not part of
// `state`/localStorage — resets on reload (except the expanded flag below) ----
interface TableEntry {
  name: string;
  li: HTMLLIElement;
  chip: HTMLElement;
}
let tableEntries: TableEntry[] = [];
const chipCounts = new Map<string, string>();
// Saved-join chips follow the table chips (after a divider) and take part in the
// same line cap, so they are hidden before the tables are, active one aside.
let joinEntries: TableEntry[] = [];
// The source and schema the join chips were built for; a table list for another scope drops them.
let joinScope = "";
const allEntries = (): TableEntry[] => [...tableEntries, ...joinEntries];
const tableChipTemplate = $<HTMLTemplateElement>("table-chip-template");

// ---- three-line cap: a long table list collapses behind "+ N more", except
// the active table, which stays visible (and is marked `pulled` when a hidden
// chip sits before it, so it is out of alphabetical order) ----
const TABLE_CAP_LINES = 3;
const tablesMore = $<HTMLButtonElement>("tables-more");
// Last item in the list, right-aligned (see styles.css), so it follows the
// final chip instead of taking width from the lines above it.
const tablesMoreItem = $("tables-more-item");
// A display preference like the theme, so its own key rather than the view
// blob that mirrors to the URL.
const TABLES_EXPANDED_KEY = "ashurbanipal_tables_expanded";
let tablesExpanded = readStored(TABLES_EXPANDED_KEY) === "true";
// The active table chip the last cap pass saw; a repeat load of the same view
// skips the measuring (an active join chip is setJoinChips' to measure).
let cappedActive: string | null = null;

// Measures the full layout (offsetTop per chip), so the cap is by rendered
// lines and tracks the list's width without a per-chip width model.
function updateTablesCap(): void {
  const entries = allEntries();
  cappedActive = tableEntries.find((e) => e.chip.classList.contains("active"))?.name ?? null;
  for (const e of entries) {
    e.li.hidden = false;
    e.li.classList.remove("pulled");
  }
  const tops = [...new Set(entries.map((e) => e.li.offsetTop))].sort((a, b) => a - b);
  const lastLineTop = tops[TABLE_CAP_LINES - 1];
  const beyond = tops.length > TABLE_CAP_LINES ? entries.filter((e) => e.li.offsetTop > lastLineTop) : [];
  const active = entries.find((e) => e.chip.classList.contains("active"));
  const hidden = new Set(beyond.filter((e) => e !== active));
  tablesMoreItem.hidden = hidden.size === 0;
  if (tablesMoreItem.hidden) return;
  tablesMore.setAttribute("aria-expanded", String(tablesExpanded));
  if (tablesExpanded) {
    tablesMore.textContent = "show fewer";
    return;
  }
  for (const e of hidden) e.li.hidden = true;
  // Measured with the divider's margin on, since only taking it off below is safe.
  active?.li.classList.add("pulled");
  // The button has to land on the last line: give up chips from the end of the
  // visible ones, never the active one, until it fits there.
  const shown = entries.filter((e) => !hidden.has(e) && e !== active);
  tablesMore.textContent = `+ ${hidden.size} more`;
  while (tablesMoreItem.offsetTop > lastLineTop && shown.length) {
    const last = shown.pop() as TableEntry;
    last.li.hidden = true;
    hidden.add(last);
    tablesMore.textContent = `+ ${hidden.size} more`;
  }
  if (!active) return;
  // Out of alphabetical order only if a hidden chip sits before it; a divider
  // at the start of a line would just dangle.
  const at = entries.indexOf(active);
  const movedUp = [...hidden].some((e) => entries.indexOf(e) < at);
  const before = entries
    .slice(0, at)
    .filter((e) => !e.li.hidden)
    .pop();
  if (!movedUp || !before || before.li.offsetTop !== active.li.offsetTop || active.li.classList.contains("join-first"))
    active.li.classList.remove("pulled");
}
tablesMore.onclick = () => {
  tablesExpanded = !tablesExpanded;
  writeStored(TABLES_EXPANDED_KEY, tablesExpanded ? "true" : null);
  updateTablesCap();
};
// A width change only: updateTablesCap itself changes the height, which must
// not re-trigger it.
let tablesWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === tablesWidth) return;
  tablesWidth = entry.contentRect.width;
  updateTablesCap();
}).observe($("tables"));

// A slower earlier loadTables() (e.g. from a schema switch quickly
// followed by another) must not replace the chips with the wrong schema's
// table list — same guard as reload.ts's load token and cvRequestToken.
let loadTablesToken = 0;

// `next`: a view in this table list to open instead of the current one; the
// stale-state fallback below drops it.
/** What a loadTables call did: a newer call superseded it, it fell back to
 * another table because the wanted one isn't listed (R5), or it loaded. */
export type TablesOutcome = "superseded" | "fell-back" | "loaded";

export async function loadTables({
  replaceHistory = false,
  next,
  reason,
}: {
  replaceHistory?: boolean;
  next?: ViewRequest;
  reason?: LoadReason;
} = {}): Promise<TablesOutcome> {
  syncGridLock();
  setStatus("loading tables…");
  const token = ++loadTablesToken;
  const [{ tables }, { counts }] = await Promise.all([
    api<{ tables: TableListEntry[] }>(`/tables${scopeQuery()}`),
    // Counts are a hint; a failure leaves the chips without them, not missing.
    api<{ counts: { table: string; approx_rows: number }[] }>(`/table-counts${scopeQuery()}`).catch((e) => {
      console.warn("ashurbanipal: /table-counts failed; showing no counts", e);
      return { counts: [] };
    }),
  ]);
  if (token !== loadTablesToken) return "superseded";
  const countMap = Object.fromEntries(counts.map((c) => [c.table, c.approx_rows]));
  const ul = $("tables");
  ul.replaceChildren();
  tableEntries = [];
  chipCounts.clear();
  for (const t of tables) {
    const li = (tableChipTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLLIElement;
    const chip = qs<HTMLAnchorElement>(li, "a");
    qs<HTMLElement>(li, ".chip-name").textContent = t.name;
    const countEl = qs<HTMLElement>(li, ".count");
    countEl.textContent = formatApproxCount(countMap[t.name]);
    chipCounts.set(t.name, countEl.textContent);
    countEl.title = APPROX_COUNT_TITLE;
    chip.dataset.table = t.name;
    // Always set, not just when commented: long names get CSS-truncated
    // (see .chip-name), so the title tooltip is the escape hatch.
    chip.title = t.comment ? `${t.name} — ${t.comment}` : t.name;
    linkTo(chip, viewHref({ kind: "table", table: t.name }), () => {
      loadData({ next: tableRequest(t.name), reason: "chip" });
    });
    prefetchOnRest(chip, t.name);
    ul.appendChild(li);
    tableEntries.push({ name: t.name, li, chip });
  }
  if (joinScope !== scopeIdentity()) joinEntries = [];
  for (const e of joinEntries) ul.appendChild(e.li);
  ul.appendChild(tablesMoreItem);
  updateTablesCap();
  markTiming("tables-listed");
  const tableNames = tables.map((t) => t.name);
  // Stale persisted state must never wedge the UI: fall back (R5).
  const fellBack = !tableNames.includes(startTable(next ? next.view : state.view) ?? "");
  if (fellBack) {
    enterTable(tableNames[0] ?? null);
    applyStoredSort(tableInView());
    // A ?filter= was written against the table the URL named; that table
    // isn't here, so its columns can't apply to the fallback — carrying it
    // over would 400 and dead-end the very load meant to recover (R5).
    clearFilter();
  }
  await loadData({ replaceHistory, next: fellBack ? undefined : next, reason });
  return fellBack ? "fell-back" : "loaded";
}

export function listedTableNames(): string[] {
  return tableEntries.map((e) => e.name);
}

// The row count the table's chip shows (`~208`), for places that list tables.
export function tableChipCount(name: string): string {
  return chipCounts.get(name) ?? "";
}

export interface JoinChip {
  label: string;
  title: string;
  className: string;
  active: boolean;
  run: () => void;
  // Set for a chip that navigates, so it renders as a link the browser can open in a new tab.
  href?: string;
}

// A plain click runs in place; every other click (middle, modified) is the
// browser's new-tab/new-window gesture and must reach it.
function linkTo(a: HTMLAnchorElement, href: string, run: () => void): HTMLAnchorElement {
  a.href = href;
  a.onclick = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    run();
  };
  return a;
}

// Only a resting mouse asks ahead: touch has no hover before its tap, and
// tabbing would focus, and so fetch, every chip it passes.
const PREFETCH_REST_MS = 100;
// Short, so a page shown from it is as fresh as one asked for on the click (R10).
const PREFETCH_TTL_MS = 5000;

function prefetchOnRest(chip: HTMLElement, name: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);
  const start = () => {
    cancel();
    timer = setTimeout(() => {
      if (name !== tableInView()) prefetch(tableDataPath(tableRequest(name)), "view", PREFETCH_TTL_MS);
    }, PREFETCH_REST_MS);
  };
  chip.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") start();
  });
  for (const type of ["pointerleave", "pointerdown"]) chip.addEventListener(type, cancel);
}

function actionButton(run: () => void): HTMLButtonElement {
  const btn = el("button");
  btn.type = "button";
  btn.onclick = run;
  return btn;
}

export function hasJoinChips(): boolean {
  return joinEntries.length > 0;
}

// Replaces the chips after the divider; called whenever the join in view or the saved list changes.
export function setJoinChips(chips: JoinChip[]): void {
  const ul = $("tables");
  for (const e of joinEntries) e.li.remove();
  joinEntries = chips.map((c, i) => {
    const li = el("li", `join-chip ${c.className}${i === 0 ? " join-first" : ""}`);
    const chip = c.href ? linkTo(el("a"), c.href, c.run) : actionButton(c.run);
    chip.textContent = c.label;
    chip.title = c.title;
    chip.classList.toggle("active", c.active);
    if (c.active) chip.setAttribute("aria-current", "true");
    li.appendChild(chip);
    ul.insertBefore(li, tablesMoreItem);
    return { name: `join:${c.label}`, li, chip };
  });
  joinScope = scopeIdentity();
  updateTablesCap();
}

// Keyed by table name rather than "whichever chip is .active" so it's
// still correct if tableEntries is ever rebuilt mid-fetch.
export function setTableChipLoading(name: string, loading: boolean): void {
  tableEntries.find((e) => e.name === name)?.chip.classList.toggle("loading", loading);
}

// Same tableEntries lookup as setTableChipLoading, so "find the chip for table X"
// stays one idiom — a re-scan on every call rather than a cached reference,
// so this self-heals if tableEntries is rebuilt (schema/source switch)
// between calls instead of toggling a detached button.
export function setActiveTable(name: string | null): void {
  for (const e of tableEntries) {
    const isActive = e.name === name;
    e.chip.classList.toggle("active", isActive);
    if (isActive) e.chip.setAttribute("aria-current", "true");
    else e.chip.removeAttribute("aria-current");
  }
  if (name !== cappedActive) updateTablesCap();
}
