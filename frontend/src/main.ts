import "./api-reference.js";
import { loadData } from "./controller.js";
import { $, reportError } from "./dom.js";
import { registerLoadData } from "./reload.js";
import { loadSchemas, loadSources, loadTables } from "./sidebar.js";
import "./sidebar-resize.js";
import { loadSiblings } from "./siblings.js";
import { getLastPayload, initState, state } from "./state.js";
import "./theme.js";

// Entry point: wiring only. Restore state (storage, then URL layered over
// it), register the reload seam so feature modules can reach loadData
// without importing controller.ts, wire the toolbar buttons and the
// payload dialog, then kick off the bootstrap sequence. All render
// orchestration lives in controller.ts.
initState();
registerLoadData(loadData);

// ---- raw payload viewer ----
$("payload").onclick = () => {
  $("payload-pre").textContent = JSON.stringify(getLastPayload(), null, 2);
  $<HTMLDialogElement>("payload-dialog").showModal();
};

$<HTMLButtonElement>("prev").onclick = () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadData({ resetScroll: false });
};
$<HTMLButtonElement>("next").onclick = () => {
  state.offset += state.limit;
  loadData({ resetScroll: false });
};
$<HTMLButtonElement>("nav-back").onclick = () => history.back();
$<HTMLButtonElement>("nav-forward").onclick = () => history.forward();
// resetScroll: false — an in-place re-fetch of the current view; highlightNew
// tints any row that wasn't in the previous result.
$<HTMLButtonElement>("refresh").onclick = () => {
  const btn = $<HTMLButtonElement>("refresh");
  // Guaranteed one rotation even on a few-ms fetch; the timer (not
  // animationend, which never fires under prefers-reduced-motion) clears it.
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 500);
  loadData({ resetScroll: false, highlightNew: true });
};

// Feeds --toolbar-h (thead th's sticky `top`) — #toolbar's height isn't
// static (flex-wrap, #error appearing/disappearing).
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--toolbar-h", `${(entry.target as HTMLElement).offsetHeight}px`);
}).observe($("toolbar"));

// loadSources resolves state.source before loadSchemas needs it, which in
// turn resolves state.schema before loadTables' first request needs it —
// bootstrap-only ordering; loadSchemas/loadTables are safe to call on their
// own after this (source/schema switching does exactly that).
loadSources().then(loadSchemas).then(loadTables).catch(reportError);
loadSiblings();
setInterval(loadSiblings, 15_000);
