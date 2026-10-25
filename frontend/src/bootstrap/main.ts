import { onProtocolSkew } from "../core/api.js";
import "../features/api-reference.js";
import { $, reportError } from "../core/dom.js";
import { applyStoredSort, getLastPayload, initState, state, tableInView } from "../core/state.js";
import { startAutoRefresh } from "../features/auto-refresh.js";
import { resetColumnWidths } from "../features/column-widths.js";
import "../features/filter-highlight.js";
import "../features/join-dialog.js";
import { clearCommonValueCache } from "../features/filter-ui.js";
import { clearJoinCatalog } from "../features/join-catalog.js";
import { startSiblings } from "../features/siblings.js";
import { loadSchemas, loadSources, loadTables } from "../features/sidebar.js";
import "../features/sticky-header.js";
import { clearStructureCache, openStructure } from "../features/structure.js";
import { showBootFallbackNote } from "../features/view-notice.js";
import { loadData } from "./controller.js";
import { registerLoadData } from "./reload.js";
import "../features/theme.js";

// Entry point: wiring only. Restore state (storage, then URL layered over
// it), register the reload seam so feature modules can reach loadData
// without importing controller.ts, wire the toolbar buttons and the
// payload dialog, then kick off the bootstrap sequence. All render
// orchestration lives in controller.ts.
initState();
registerLoadData(loadData);

// loadData() and the sibling fetches run unawaited and their own try/catch
// covers only the fetch, so a render-phase throw would otherwise vanish.
// Console only — the #error banner is for user-actionable failures, which a
// sibling refresh is not.
window.addEventListener("unhandledrejection", (ev) => {
  console.error("ashurbanipal: unhandled promise rejection", ev.reason);
});

// Protocol-skew banner: api.ts flags a version mismatch on the first
// /tables response; this owns the DOM it shows in.
onProtocolSkew((message) => {
  $("protocol-warning-text").textContent = message;
  $("protocol-warning").hidden = false;
  $<HTMLButtonElement>("protocol-warning-dismiss").onclick = () => {
    $("protocol-warning").hidden = true;
  };
});

// ---- raw payload viewer ----
$("payload").onclick = () => {
  $("payload-pre").textContent = JSON.stringify(getLastPayload(), null, 2);
  $<HTMLDialogElement>("payload-dialog").showModal();
};

$("structure-btn").onclick = openStructure;

$<HTMLButtonElement>("prev").onclick = () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadData({ resetScroll: false });
};
$<HTMLButtonElement>("next").onclick = () => {
  state.offset += state.limit;
  loadData({ resetScroll: false });
};
// resetScroll: false — an in-place re-fetch of the current view; highlightNew
// tints any row that wasn't in the previous result.
$<HTMLButtonElement>("refresh").onclick = () => {
  const btn = $<HTMLButtonElement>("refresh");
  clearStructureCache();
  clearCommonValueCache();
  clearJoinCatalog();
  resetColumnWidths();
  // Guaranteed one rotation even on a few-ms fetch; the timer (not
  // animationend, which never fires under prefers-reduced-motion) clears it.
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 500);
  loadData({ resetScroll: false, highlightNew: true });
};

// Bootstrap-only order (a source switch reruns the last two alone): the source,
// then the schema, are fixed before the next step's first request. The fallback
// note waits for loadTables' first load; #tables' markup aria-busy (on the list,
// not <main>, so live regions still announce) clears once all of it settles.
loadSources()
  .then(loadSchemas)
  .then(() => {
    // A link without ?sort= opens with the table's remembered one (R11), once the scope it is keyed by is pinned.
    if (state.sort === null) applyStoredSort(tableInView());
    return loadTables({ replaceHistory: true });
  })
  .catch(reportError)
  .finally(() => {
    try {
      showBootFallbackNote();
    } finally {
      $("tables").removeAttribute("aria-busy");
    }
  });
startSiblings();
startAutoRefresh();
