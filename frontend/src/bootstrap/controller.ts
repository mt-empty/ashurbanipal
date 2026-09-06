import { api } from "../core/api.js";
import { $, clearError, flashIcon, reportError, setStatus } from "../core/dom.js";
import {
  applyScopeParams,
  diffNewRows,
  dropOneStaleInput,
  getAppliedFilterAst,
  markFilterVerified,
  markStoredSortVerified,
  state,
} from "../core/state.js";
import type { TableData } from "../core/types.js";
import { renderColumnMenu, renderHeader, renderRows, updateColumnsButtonLabel, updatePager } from "../features/grid.js";
import { syncUrl } from "../features/nav.js";
import { setActiveTable, setRowLoading } from "../features/sidebar.js";
import { captureTableFocus, restoreTableFocus, tableEl } from "./table-focus.js";

// The render-orchestration hub: loadData sequences fetch -> chrome ->
// header/body/menu -> pager. Feature modules never import this file (that
// would re-form a cycle through the modules it imports below) — they call
// loadData via reload.ts, which main.ts wires to the export here.

// aria-busy is held by two independent things — an in-flight fetch and an
// in-progress view transition — so it is set and cleared through one place.
function setTableBusy(busy: boolean): void {
  if (busy) tableEl.setAttribute("aria-busy", "true");
  else tableEl.removeAttribute("aria-busy");
}

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
    table,
    limit: String(state.limit),
    offset: String(state.offset),
  });
  if (state.sort) {
    params.set("sort", state.sort);
    params.set("order", state.order);
  }
  applyScopeParams(params);
  // The wire format is the JSON AST (spec/protocol.md §5.4.2), never the
  // box's DSL text — URLSearchParams handles the URL-encoding.
  if (state.filter) params.set("filter", JSON.stringify(getAppliedFilterAst()));
  if (inFlightFetches++ === 0) {
    setStatus("loading…");
    setTableBusy(true);
  }
  setRowLoading(table, true);
  try {
    return await api<TableData>(`/tables/data?${params}`);
  } finally {
    setRowLoading(table, false);
    if (--inFlightFetches === 0) {
      setStatus("");
      setTableBusy(false);
    }
  }
}

// Must only ever move in lockstep with a *successful* render, never ahead
// of it — a failed fetchTableData() (see loadData) must leave these
// exactly as they were, matching the stale <table> body they describe.
function updateActiveTableChrome(): void {
  setActiveTable(state.table);
  $("current").textContent = state.table ?? "—";
  document.title = state.table ? `${state.table} — Ashurbanipal` : "Ashurbanipal";
}

// loadData() has multiple entry points (table switch, sort click, filter
// submit, pager); without this, an older slower request's response could
// land after a newer one and overwrite its already-rendered result — the
// grid would show a different table's columns/rows than #current claims.
// Same shape of fix as showCommonValues's cvRequestToken.
let loadDataToken = 0;

export async function loadData({
  resetScroll = true,
  highlightNew = false,
}: {
  resetScroll?: boolean;
  highlightNew?: boolean;
} = {}): Promise<void> {
  clearError();
  if (!state.table) {
    updateActiveTableChrome();
    setStatus("");
    return;
  }
  const token = ++loadDataToken;
  let data: TableData;
  try {
    data = await fetchTableData();
  } catch (e) {
    if (token !== loadDataToken) return; // superseded by a newer request
    // A restored sort or a URL-restored filter can each name a column that no
    // longer exists, so drop one and retry — at most one per call (sort before
    // filter, ui-guidelines R11), leaving the other a chance to render.
    if (dropOneStaleInput()) return loadData({ resetScroll, highlightNew });
    reportError(e);
    return;
  }
  if (token !== loadDataToken) return; // superseded by a newer request
  markStoredSortVerified();
  markFilterVerified();
  updateActiveTableChrome();

  const { newRowKeys, pkNames } = diffNewRows(data, highlightNew);

  $<HTMLButtonElement>("payload").disabled = false;
  $<HTMLButtonElement>("columns-btn").disabled = false;
  $<HTMLButtonElement>("refresh").disabled = false;
  updateColumnsButtonLabel();
  syncUrl();
  const renderTable = () => {
    const focusCapture = captureTableFocus();
    renderHeader(data.columns);
    renderRows(data, newRowKeys, pkNames);
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
    setTableBusy(true);
    await document.startViewTransition(renderTable).updateCallbackDone;
    setTableBusy(false);
  } else {
    renderTable();
  }
  // The await above yields; a table switch during the transition supersedes
  // this load, and its pager/#status must not overwrite the newer one's.
  if (token !== loadDataToken) return;
  updatePager(data);
  // Sighted users see the tint; announce the count for everyone else. The
  // next loadData clears #status the same way it clears "loading…".
  if (newRowKeys?.size) {
    setStatus(`${newRowKeys.size} new`);
  } else if (highlightNew && newRowKeys) {
    // A refresh that found nothing new: the row tint won't fire, so the
    // button gets its own "done, unchanged" cue — a ✓ glyph swap mirroring
    // the copy buttons, plus the sr-only #status line.
    setStatus("no changes");
    flashIcon($("refresh-icon"), "✓", 1000);
  }
  // Default true: table switch and filter submit jump to a new row 0, so
  // snapping to the top orients the user. Sort and prev/next explicitly
  // pass resetScroll: false — they're in-place operations on the current
  // view, and jumping the scroll position out from under the click that
  // triggered them would be disorienting, not helpful.
  if (resetScroll) $("main").scrollTo({ top: 0, left: 0, behavior: "smooth" });
}
