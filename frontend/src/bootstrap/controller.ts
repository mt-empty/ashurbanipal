import { ApiError, api } from "../core/api.js";
import { $, clearError, flashIcon, reportError, setStatus } from "../core/dom.js";
import {
  applyScopeParams,
  diffNewRows,
  dropOneStaleInput,
  getAppliedFilterAst,
  getAppliedJoin,
  markFilterVerified,
  markStoredSortVerified,
  state,
} from "../core/state.js";
import type { JoinDef, TableData } from "../core/types.js";
import { currentWidthScope, rememberColumnWidths, useWidthScope } from "../features/column-widths.js";
import { renderColumnMenu, renderHeader, renderRows, updateColumnsButtonLabel, updatePager } from "../features/grid.js";
import { tableColumns } from "../features/join-catalog.js";
import { openJoinDialog, refreshSavedChips } from "../features/join-dialog.js";
import { clearJoinNotice, showJoinNotice, splitColumnKey, updateJoinChrome } from "../features/join-view.js";
import { syncUrl } from "../features/nav.js";
import { setActiveTable, setRowLoading } from "../features/sidebar.js";
import { joinLabel, tablesToExpand, toWire } from "../lib/join-def.js";
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

const JOIN_WIRE_LIMIT = 8192;

// `alias.*` has no wire form, so those tables' column names come from the catalog.
async function joinPath(def: JoinDef, params: URLSearchParams): Promise<string> {
  const names = new Map<number, string[]>();
  await Promise.all(
    tablesToExpand(def).map(async (position) => {
      names.set(
        position,
        (await tableColumns(def.tables[position].table)).map((c) => c.name),
      );
    }),
  );
  const wire = JSON.stringify(toWire(def, (position) => names.get(position) ?? []));
  // The server rejects a longer `join` (spec/protocol.md §5.11.1); say why before sending.
  if (new TextEncoder().encode(wire).length > JOIN_WIRE_LIMIT)
    throw new ApiError("This join lists too many columns. Untick some columns or remove a table.", undefined, 400);
  params.set("join", wire);
  return `/tables/join?${params}`;
}

// The join text that last loaded: once a join has rendered, a 400 is about the
// filter or sort on top of it, which the plain error line reports.
let loadedJoin = "";

// A timeout or a rejected join gets the join's own UI instead of the plain
// error line. A bad filter is the filter bar's to report.
function reportJoinFailure(e: ApiError): boolean {
  if (e.code === "query_timeout") {
    showJoinNotice(
      "This join took longer than the time limit and was stopped. Add a filter, remove a table, or join on key columns.",
      [
        { label: "Retry", run: () => loadData() },
        { label: "Edit join", run: () => openJoinDialog() },
      ],
    );
    return true;
  }
  if (e.status === 400 && e.code !== "invalid_filter" && state.join !== loadedJoin) {
    openJoinDialog({ error: e.message });
    return true;
  }
  return false;
}

async function fetchTableData(): Promise<TableData> {
  // Captured once, never re-read later: without this, a slow fetch for
  // table A would clear table B's row-loading flag (whatever state.table
  // had become by the time A's `finally` runs) instead of its own.
  const table = state.table ?? "";
  const join = getAppliedJoin();
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
  });
  if (!join) params.set("table", table);
  if (state.sort) {
    // In a join view the sort is `alias.column`; the wire wants the column and its table position.
    const target = join ? splitColumnKey(state.sort) : { column: state.sort, join: undefined };
    if (target) {
      params.set("sort", target.column);
      if (target.join !== undefined) params.set("sort_join", String(target.join));
      params.set("order", state.order);
    }
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
    return await api<TableData>(join ? await joinPath(join, params) : `/tables/data?${params}`);
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
  const join = getAppliedJoin();
  const title = join ? joinLabel(join) : state.table;
  setActiveTable(join ? null : state.table);
  $("current").textContent = title ?? "—";
  document.title = title ? `${title} — Ashurbanipal` : "Ashurbanipal";
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
  clearJoinNotice();
  if (!state.table) {
    updateActiveTableChrome();
    setStatus("");
    return;
  }
  const token = ++loadDataToken;
  const widthScope = currentWidthScope();
  let data: TableData;
  try {
    data = await fetchTableData();
  } catch (e) {
    if (token !== loadDataToken) return; // superseded by a newer request
    // A restored sort or a URL-restored filter can each name a column that no
    // longer exists, so drop one and retry — at most one per call (sort before
    // filter, ui-guidelines R11), leaving the other a chance to render.
    if (dropOneStaleInput()) return loadData({ resetScroll, highlightNew });
    // The one code the frontend branches on (ui-guidelines R9): a table
    // that cleared the table listing but the role can't actually
    // read (e.g. a stale MySQL/MariaDB listing, docs/adapter-decisions.md
    // §5.2/§5.3) gets a plain-language message instead of the server's
    // implementation-defined title text.
    if (state.join && e instanceof ApiError && reportJoinFailure(e)) return;
    if (e instanceof ApiError && e.code === "not_readable") {
      reportError(new Error(`you don't have access to ${state.table}`));
      return;
    }
    reportError(e);
    return;
  }
  if (token !== loadDataToken) return; // superseded by a newer request
  markStoredSortVerified();
  markFilterVerified();
  loadedJoin = state.join;
  updateActiveTableChrome();

  // Row keys come from primary keys, which a join of several tables does not have.
  const { newRowKeys, pkNames } = diffNewRows(data, highlightNew && !state.join);

  $<HTMLButtonElement>("payload").disabled = false;
  $<HTMLButtonElement>("columns-btn").disabled = false;
  $<HTMLButtonElement>("structure-btn").disabled = state.join !== "";
  $<HTMLButtonElement>("refresh").disabled = false;
  updateColumnsButtonLabel();
  updateJoinChrome();
  refreshSavedChips();
  syncUrl();
  const renderTable = () => {
    useWidthScope(widthScope);
    const focusCapture = captureTableFocus();
    renderHeader(data.columns);
    renderRows(data, newRowKeys, pkNames);
    rememberColumnWidths();
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
