import { ApiError, api } from "../core/api.js";
import { $, clearError, reportError, setStatus } from "../core/dom.js";
import {
  applyScopeParams,
  commitRequest,
  currentRequest,
  diffNewRows,
  dropOneStaleInput,
  markFilterVerified,
  markStoredSortVerified,
  markViewShown,
  startTable,
  state,
  tableInView,
  type ViewRequest,
} from "../core/state.js";
import type { JoinDef, View, ViewData } from "../core/types.js";
import { noteLoadOk, noteTickFailed, setFetching, setNewChip } from "../features/auto-refresh.js";
import { rememberColumnWidths, useWidthScope, widthScopeOf } from "../features/column-widths.js";
import { renderColumnMenu, renderHeader, renderRows, updateColumnsButtonLabel, updatePager } from "../features/grid.js";
import { seedColumns, tableColumns } from "../features/join-catalog.js";
import { openJoinDialog, refreshSavedChips } from "../features/join-dialog.js";
import { clearJoinNotice, showJoinNotice, splitColumnKey, updateJoinChrome } from "../features/join-view.js";
import { setLoadingBar } from "../features/load-bar.js";
import { syncUrl } from "../features/nav.js";
import { setActiveTable, setRowLoading } from "../features/sidebar.js";
import { syncViewNotice } from "../features/view-notice.js";
import { joinLabel, tablesToExpand, toWire } from "../lib/join-def.js";
import { JOIN_MAX_BYTES } from "../lib/join-dsl.js";
import { isCurrentLoad, nextLoadToken } from "./reload.js";
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

// Reference-counted, not a plain boolean: fetchViewData() can be in
// flight more than once (switching views again before the previous fetch
// resolves), and a plain true/false pair would let the first fetch to
// finish clear aria-busy/#status while another is still running.
let inFlightFetches = 0;

// A fetch that answers within this delay shows nothing, so fast ones never flash.
const LOADING_DELAY_MS = 250;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

// Everything a sighted or screen-reader user sees of a slow fetch comes on
// together; an auto tick stays silent so a screen reader isn't told every interval.
function setSlow(slow: boolean, announce = true): void {
  tableEl.toggleAttribute("data-slow", slow);
  setLoadingBar(slow);
  if (announce || !slow) setStatus(slow ? "loading…" : "");
}

// The one code the frontend branches on (ui-guidelines R9): a table that
// cleared the table listing but the role can't actually read (e.g. a stale
// MySQL/MariaDB listing, docs/adapter-decisions.md §5.2/§5.3) gets a
// plain-language message instead of the server's implementation-defined title.
function plainError(e: unknown, view: View): unknown {
  return e instanceof ApiError && e.code === "not_readable"
    ? new Error(`you don't have access to ${startTable(view)}`)
    : e;
}

// `alias.*` has no wire form, so those tables' column names come from the catalog.
async function joinPath(def: JoinDef, params: URLSearchParams): Promise<string> {
  const names = new Map<number, string[]>();
  await Promise.all(
    tablesToExpand(def).map(async (position) => {
      // A table gone from the catalog is the join's problem, answered in its dialog like the server's invalid_join.
      const columns = await tableColumns(def.tables[position].table).catch((e: unknown) => {
        throw e instanceof ApiError && e.code === "unknown_table" ? new ApiError(e.message, "invalid_join") : e;
      });
      names.set(
        position,
        columns.map((c) => c.name),
      );
    }),
  );
  const wire = JSON.stringify(toWire(def, (position) => names.get(position) ?? []));
  // The server rejects a longer `join` (spec/protocol.md §5.11.1); say why before sending.
  if (new TextEncoder().encode(wire).length > JOIN_MAX_BYTES)
    throw new ApiError("This join lists too many columns. Untick some columns or remove a table.", "invalid_join");
  params.set("join", wire);
  return `/tables/join?${params}`;
}

// A timeout or a rejected join gets the join's own UI instead of the plain
// error line; on this route `not_readable` can only name one of the join's
// tables. Any other 400 (filter, sort) is the plain error line's. `next` is
// the join not yet in view, if this load was trying one.
function reportJoinFailure(e: ApiError, def: JoinDef, next: ViewRequest | undefined): boolean {
  if (e.code === "query_timeout") {
    showJoinNotice(
      "This join took longer than the time limit and was stopped. Add a filter, remove a table, or join on key columns.",
      [
        { label: "Retry", run: () => loadData({ next }) },
        { label: "Edit join", run: () => openJoinDialog({ def }) },
      ],
    );
    return true;
  }
  if (e.code === "invalid_join" || e.code === "not_readable") {
    openJoinDialog({ error: e.message, def });
    return true;
  }
  return false;
}

function dataPath(view: View, params: URLSearchParams): Promise<string> | string {
  switch (view.kind) {
    case "table":
      return `/tables/data?${params}`;
    case "join":
      return joinPath(view.def, params);
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

async function fetchViewData(req: ViewRequest, auto: boolean): Promise<ViewData> {
  const { view, sort, order } = req;
  // Captured once, never re-read later: without this, a slow fetch for
  // table A would clear table B's row-loading flag (whatever the view
  // had become by the time A's `finally` runs) instead of its own.
  const table = startTable(view);
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(req.offset),
  });
  if (view.kind === "table") params.set("table", view.table);
  if (sort) {
    // In a join view the sort is `alias.column`; the wire wants the column and its table position.
    const target = view.kind === "join" ? splitColumnKey(sort, view.def) : { column: sort, join: undefined };
    if (target) {
      params.set("sort", target.column);
      if (target.join !== undefined) params.set("sort_join", String(target.join));
      params.set("order", order);
    }
  }
  applyScopeParams(params);
  // The wire format is the JSON AST (spec/protocol.md §5.4.2), never the
  // box's DSL text — URLSearchParams handles the URL-encoding.
  if (req.filter) params.set("filter", JSON.stringify(req.ast));
  if (inFlightFetches++ === 0) {
    setFetching(true);
    setTableBusy(true);
    slowTimer = setTimeout(() => setSlow(true, !auto), LOADING_DELAY_MS);
  }
  setRowLoading(table, true);
  try {
    return await api<ViewData>(await dataPath(view, params));
  } finally {
    setRowLoading(table, false);
    if (--inFlightFetches === 0) {
      clearTimeout(slowTimer);
      setSlow(false);
      setTableBusy(false);
      setFetching(false);
    }
  }
}

function viewTitle(view: View | null): string | null {
  if (view === null) return null;
  switch (view.kind) {
    case "table":
      return view.table;
    case "join":
      return joinLabel(view.def);
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

// Must only ever move in lockstep with a *successful* render, never ahead
// of it — a failed fetchViewData() (see loadData) must leave these
// exactly as they were, matching the stale <table> body they describe.
function updateViewChrome(): void {
  const title = viewTitle(state.view);
  setActiveTable(tableInView());
  $("current").textContent = title ?? "—";
  document.title = title ? `${title} — Ashurbanipal` : "Ashurbanipal";
}

export async function loadData({
  resetScroll = true,
  highlightNew = false,
  auto = false,
  next,
}: {
  resetScroll?: boolean;
  highlightNew?: boolean;
  // An auto-refresh tick: it only re-fetches, so it never retries a dropped sort or filter,
  // opens the join dialog, or clears a message the user's own last action left.
  auto?: boolean;
  // A view to try; it replaces the state only if its data arrives.
  next?: ViewRequest;
} = {}): Promise<void> {
  if (!auto) {
    clearError();
    clearJoinNotice();
  }
  const req = next ?? currentRequest();
  syncViewNotice(req);
  if (req === null) {
    updateViewChrome();
    setStatus("");
    return;
  }
  const view = req.view;
  // An older, slower response must not overwrite a newer view (reload.ts).
  const token = nextLoadToken();
  const superseded = () => !isCurrentLoad(token);
  const widthScope = widthScopeOf(view);
  let data: ViewData;
  try {
    data = await fetchViewData(req, auto);
  } catch (e) {
    if (superseded()) return;
    if (auto) {
      noteTickFailed(plainError(e, view));
      return;
    }
    // A restored sort or a URL-restored filter can each name a column that no
    // longer exists, so drop one and retry — at most one per call (sort before
    // filter, ui-guidelines R11), leaving the other a chance to render.
    // A view not yet in view restored nothing; its failure leaves the state alone.
    if (!next && dropOneStaleInput(e instanceof ApiError ? e.code : undefined))
      return loadData({ resetScroll, highlightNew });
    if (view.kind === "join" && e instanceof ApiError && reportJoinFailure(e, view.def, next)) return;
    reportError(plainError(e, view));
    return;
  }
  if (superseded()) return;
  if (next) commitRequest(next);
  markStoredSortVerified();
  markFilterVerified();
  markViewShown();
  if (view.kind === "table") seedColumns(view.table, data.columns);
  updateViewChrome();

  // Row keys come from primary keys, which a join of several tables does not have.
  const { newRowKeys, pkNames } = diffNewRows(data, highlightNew && view.kind === "table");

  $<HTMLButtonElement>("payload").disabled = false;
  $<HTMLButtonElement>("columns-btn").disabled = false;
  $<HTMLButtonElement>("structure-btn").disabled = false;
  $<HTMLButtonElement>("refresh").disabled = false;
  $<HTMLButtonElement>("refresh-menu-btn").disabled = false;
  updateColumnsButtonLabel();
  updateJoinChrome();
  refreshSavedChips();
  syncUrl();
  const renderTable = () => {
    // The transition can wait for a frame; a view switch meanwhile owns the grid, and this data is not its join's.
    if (superseded()) return;
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
  if (superseded()) return;
  updatePager(data);
  noteLoadOk();
  // Sighted users see the tint; announce the count for everyone else. The
  // next loadData clears #status the same way it clears "loading…".
  setNewChip(newRowKeys?.size ?? 0);
  if (newRowKeys?.size) {
    setStatus(`${newRowKeys.size} new`);
  } else if (highlightNew && newRowKeys && !auto) {
    // Nothing new, so no tint: the icon's spin and the "updated" time are the
    // sighted cue; this line is for everyone else.
    setStatus("no changes");
  }
  // Default true: table switch and filter submit jump to a new row 0, so
  // snapping to the top orients the user. Sort and prev/next explicitly
  // pass resetScroll: false — they're in-place operations on the current
  // view, and jumping the scroll position out from under the click that
  // triggered them would be disorienting, not helpful.
  if (resetScroll) $("main").scrollTo({ top: 0, left: 0, behavior: "smooth" });
}
