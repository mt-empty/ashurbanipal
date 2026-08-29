import { api } from "./api.js";
import "./api-reference.js";
import { $, setStatus } from "./dom.js";
import { renderColumnMenu, renderHeader, renderRows, updateColumnsButtonLabel, updatePager } from "./grid.js";
import { syncUrl } from "./nav.js";
import { loadSchemas, loadSources, loadTables, setRowLoading } from "./sidebar.js";
import "./sidebar-resize.js";
import { loadSiblings } from "./siblings.js";
import { applyScopeParams, getAppliedFilterAst, getLastPayload, getLastScopeKey, rowKey, scopeKey, setLastPayload, setLastScopeKey, state } from "./state.js";
import "./theme.js";
import type { TableData } from "./types.js";

// ---- raw payload viewer ----
$("payload").onclick = () => {
  $("payload-pre").textContent = JSON.stringify(getLastPayload(), null, 2);
  $<HTMLDialogElement>("payload-dialog").showModal();
};

// Reference-counted, not a plain boolean: fetchTableData() can be in
// flight more than once (switching tables again before the previous fetch
// resolves), and a plain true/false pair would let the first fetch to
// finish clear aria-busy/#status while another is still running.
let inFlightFetches = 0;

async function fetchTableData(): Promise<TableData> {
  // Captured once, never re-read later: without this, a slow fetch for
  // table A would clear table B's row-loading flag (whatever state.table
  // had become by the time A's `finally` runs) instead of its own.
  const table = state.table ?? "";
  const params = new URLSearchParams({
    table, limit: String(state.limit), offset: String(state.offset),
  });
  if (state.sort) { params.set("sort", state.sort); params.set("order", state.order); }
  applyScopeParams(params);
  // The wire format is the JSON AST (spec/protocol.md §5.4.2), never the
  // box's DSL text — URLSearchParams handles the URL-encoding.
  if (state.filter) params.set("filter", JSON.stringify(getAppliedFilterAst()));
  if (inFlightFetches++ === 0) {
    setStatus("loading…");
    document.querySelector("table")!.setAttribute("aria-busy", "true");
  }
  setRowLoading(table, true);
  try {
    return await api<TableData>("/tables/data?" + params);
  } finally {
    setRowLoading(table, false);
    if (--inFlightFetches === 0) {
      setStatus("");
      document.querySelector("table")!.removeAttribute("aria-busy");
    }
  }
}

// ---- focus preservation across thead/tbody re-renders ----
// replaceChildren() detaches whatever was focused inside it, and the
// browser falls back to <body> — a real defect for keyboard users on every
// sort/page/filter/table-switch change. Capture the focused cell's
// position before the replace and restore it afterward, falling back to
// the table itself (tabindex="-1") if that slot no longer exists. Covers
// both tbody and thead (the common-values ▾ button).
interface FocusCapture {
  region: string; // "thead" | "tbody"
  rowIndex: number;
  colIndex: number;
  className: string;
}

function captureTableFocus(): FocusCapture | null {
  const active = document.activeElement;
  const table = document.querySelector("table")!;
  if (!active || !table.contains(active)) return null;
  const cell = active.closest("th, td");
  const tr = active.closest("tr");
  if (!cell || !tr) return null;
  return {
    region: tr.parentElement!.id,
    rowIndex: [...tr.parentElement!.children].indexOf(tr),
    colIndex: [...tr.children].indexOf(cell),
    className: active.className,
  };
}

function restoreTableFocus(captured: FocusCapture | null): void {
  if (!captured) return;
  const tr = $(captured.region)?.children[captured.rowIndex];
  const cell = tr?.children[captured.colIndex];
  // className can carry more than one class (e.g. a focused FK cell's
  // button is both "cell-text" and "fk-cell") — join them into a single
  // compound selector instead of interpolating the raw string, which
  // `.${className}` would otherwise parse as a descendant combinator.
  const classSelector = captured.className.trim().split(/\s+/).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join("");
  const target = classSelector ? cell?.querySelector<HTMLElement>(classSelector) : null;
  (target ?? document.querySelector<HTMLElement>("table")!).focus();
}

// Must only ever move in lockstep with a *successful* render, never ahead
// of it — a failed fetchTableData() (see loadData) must leave these
// exactly as they were, matching the stale <table> body they describe.
function updateActiveTableChrome(): void {
  document.querySelectorAll<HTMLButtonElement>("#tables button").forEach((b) => {
    const isActive = b.dataset.table === state.table;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  $("current").textContent = state.table ?? "—";
  document.title = state.table ? `${state.table} — Ashurbanipal` : "Ashurbanipal";
}

// loadData() has multiple entry points (table switch, sort click, filter
// submit, pager); without this, an older slower request's response could
// land after a newer one and overwrite its already-rendered result — the
// grid would show a different table's columns/rows than #current claims.
// Same shape of fix as showCommonValues's cvRequestToken.
let loadDataToken = 0;

export async function loadData({ resetScroll = true, highlightNew = false }: { resetScroll?: boolean; highlightNew?: boolean } = {}): Promise<void> {
  $("error").textContent = "";
  if (!state.table) { updateActiveTableChrome(); setStatus(""); return; }
  const token = ++loadDataToken;
  let data: TableData;
  try { data = await fetchTableData(); }
  catch (e) {
    if (token !== loadDataToken) return; // superseded by a newer request
    $("error").textContent = (e as Error).message;
    return;
  }
  if (token !== loadDataToken) return; // superseded by a newer request
  updateActiveTableChrome();

  // Rows present now but absent from the previous fetch of this same view.
  // Only computed on an explicit refresh (highlightNew), only when the
  // scope is unchanged (a sort/filter/page change makes every row "new"),
  // and only for a table with a PK to identify rows by.
  let newRowKeys: Set<string> | undefined;
  const prev = getLastPayload();
  const nowScope = scopeKey();
  if (highlightNew && prev && getLastScopeKey() === nowScope) {
    const pkNames = data.columns.filter((c) => c.key === "pk").map((c) => c.name);
    if (pkNames.length) {
      const prevKeys = new Set(prev.rows.map((r) => rowKey(pkNames, r)));
      newRowKeys = new Set(data.rows.map((r) => rowKey(pkNames, r)).filter((k) => !prevKeys.has(k)));
    }
  }
  setLastPayload(data);
  setLastScopeKey(nowScope);

  $<HTMLButtonElement>("payload").disabled = false;
  $<HTMLButtonElement>("columns-btn").disabled = false;
  $<HTMLButtonElement>("refresh").disabled = false;
  updateColumnsButtonLabel();
  syncUrl();
  const renderTable = () => {
    const focusCapture = captureTableFocus();
    renderHeader(data.columns);
    renderRows(data, newRowKeys);
    renderColumnMenu(data.columns);
    restoreTableFocus(focusCapture);
  };
  // startViewTransition's callback isn't guaranteed to run synchronously —
  // it waits for a rendering opportunity to snapshot the old frame first.
  // Under contention that gap can outlast a poll for "no animations yet",
  // which reads as settled before the DOM (and thus row content) actually
  // updated. Holding aria-busy across the callback closes that window;
  // waitForIdle's own animation-poll only proves a transition isn't
  // *currently* running, not that one has already happened.
  if (document.startViewTransition) {
    document.querySelector("table")!.setAttribute("aria-busy", "true");
    await document.startViewTransition(renderTable).updateCallbackDone;
    document.querySelector("table")!.removeAttribute("aria-busy");
  } else {
    renderTable();
  }
  updatePager(data);
  // Sighted users see the tint; announce the count for everyone else. The
  // next loadData clears #status the same way it clears "loading…".
  if (newRowKeys?.size) setStatus(`${newRowKeys.size} new`);
  // Default true: table switch and filter submit jump to a new row 0, so
  // snapping to the top orients the user. Sort and prev/next explicitly
  // pass resetScroll: false — they're in-place operations on the current
  // view, and jumping the scroll position out from under the click that
  // triggered them would be disorienting, not helpful.
  if (resetScroll) $("main").scrollTo({ top: 0, left: 0, behavior: "smooth" });
}

$<HTMLButtonElement>("prev").onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadData({ resetScroll: false }); };
$<HTMLButtonElement>("next").onclick = () => { state.offset += state.limit; loadData({ resetScroll: false }); };
$<HTMLButtonElement>("nav-back").onclick = () => history.back();
$<HTMLButtonElement>("nav-forward").onclick = () => history.forward();
// resetScroll: false — an in-place re-fetch of the current view; highlightNew
// tints any row that wasn't in the previous result.
$<HTMLButtonElement>("refresh").onclick = () => loadData({ resetScroll: false, highlightNew: true });

// Feeds --toolbar-h (thead th's sticky `top`) — #toolbar's height isn't
// static (flex-wrap, #error appearing/disappearing).
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--toolbar-h", `${(entry.target as HTMLElement).offsetHeight}px`);
}).observe($("toolbar"));

// loadSources resolves state.source before loadSchemas needs it, which in
// turn resolves state.schema before loadTables' first request needs it —
// bootstrap-only ordering; loadSchemas/loadTables are safe to call on their
// own after this (source/schema switching does exactly that).
loadSources().then(loadSchemas).then(loadTables).catch((e) => { $("error").textContent = e.message; });
loadSiblings();
setInterval(loadSiblings, 15_000);
