import { $ } from "../core/dom.js";
import { writeStored } from "../core/storage.js";

// ==== Table list: side panel or chips ====
// A display preference like the theme: its own key, outside the view blob
// that mirrors to the URL. The inline <script> in <head> sets the mode
// before first paint (a stored choice, else hidden in a narrow window);
// a default is never written, so a later wide window opens it again.
const TABLES_PANEL_KEY = "ashurbanipal_tables_panel";
const root = document.documentElement;
const toggle = $<HTMLButtonElement>("tables-panel-toggle");
const panel = $("tables-panel");

export function tablesPanelOpen(): boolean {
  return root.dataset.tablesPanel !== "hidden";
}

function label(): void {
  const text = tablesPanelOpen() ? "Hide the table list" : "Show the table list";
  toggle.setAttribute("aria-label", text);
  toggle.title = text;
}

// The same button heads the panel and starts the chip row, so focus stays on it.
// The list's width changes with it, which reruns table-chips.ts's cap pass.
toggle.onclick = () => {
  const next = tablesPanelOpen() ? "hidden" : "open";
  root.dataset.tablesPanel = next;
  writeStored(TABLES_PANEL_KEY, next);
  label();
};
label();

// The panel ends at main's bottom edge: its height is main's visible height
// less the masthead still in view. Any taller and it would overflow main at
// rest, giving even an empty table a scrollbar.
const main = $("main");
const masthead = $("masthead");
let panelHeight = -1;
function fitPanel(): void {
  const mainBox = main.getBoundingClientRect();
  const shown = Math.max(0, masthead.getBoundingClientRect().bottom - mainBox.top);
  const height = Math.max(0, Math.floor(main.clientHeight - shown));
  if (height === panelHeight) return;
  panelHeight = height;
  root.style.setProperty("--tables-panel-h", `${height}px`);
}
main.addEventListener("scroll", fitPanel, { passive: true });
const fit = new ResizeObserver(fitPanel);
fit.observe(main);
fit.observe(masthead);

// Scrolls the panel, not main, until `entry` is in view. At rest the panel
// runs below main's bottom edge, which bounds it.
export function revealInPanel(entry: HTMLElement): void {
  const box = panel.getBoundingClientRect();
  const bottom = Math.min(box.bottom, main.getBoundingClientRect().bottom);
  const r = entry.getBoundingClientRect();
  if (r.bottom > bottom) panel.scrollTop += r.bottom - bottom;
  else if (r.top < box.top) panel.scrollTop -= box.top - r.top;
}
