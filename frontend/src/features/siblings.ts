import { api } from "../core/api.js";
import { $, el } from "../core/dom.js";
import type { Sibling, SiblingsResponse } from "../core/types.js";
import { buildSiblingMatrix, type MatrixCell, type SiblingMatrix, sameViewHref } from "../lib/sibling-matrix.js";
import { setNoticePlace } from "./view-notice.js";

// Each fetch makes the server health-check every sibling, so the list is
// fetched once at load (the pill and the fallback note need it), then only
// while the pop-up is open and the tab visible, and never when the last
// result is younger than this.
const FRESH_MS = 15_000;
// A fetch that hangs past this is abandoned, so it can't block the next one.
const FETCH_TIMEOUT_MS = 10_000;

let lastFetchStarted = Number.NEGATIVE_INFINITY;
let inFlight = false;
let openTimer: ReturnType<typeof setInterval> | undefined;
// Warn once per outage, not on every refresh; re-armed on the next success.
let siblingsWarned = false;

// The rendered matrix's shape, and its link cells by service and label, so a
// poll that changes only health updates cells in place and keeps focus.
let matrixShape = "";
const linkCells = new Map<string, { a: HTMLAnchorElement; dot: HTMLElement; state: HTMLElement }>();
const sameViewLinks: { a: HTMLAnchorElement; base: string }[] = [];
let lastUpdated: HTMLTimeElement | null = null;

export function startSiblings(): void {
  void loadSiblings();
  // A hidden tab skips the refresh; coming back to it with the pop-up open catches up.
  document.addEventListener("visibilitychange", () => {
    if ($("siblings-pop").matches(":popover-open")) refreshIfStale();
  });
}

function refreshIfStale(): void {
  if (document.hidden || inFlight || performance.now() - lastFetchStarted < FRESH_MS) return;
  void loadSiblings();
}

async function loadSiblings(): Promise<void> {
  inFlight = true;
  lastFetchStarted = performance.now();
  let body: SiblingsResponse = { siblings: [] };
  let fetched = false;
  try {
    // no-store: Chrome otherwise queues an identical GET behind one still in
    // flight, for up to 20 s.
    body = await api<SiblingsResponse>("/siblings", {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    fetched = true;
    siblingsWarned = false;
  } catch (e) {
    if (!siblingsWarned) {
      console.warn("ashurbanipal: /siblings fetch failed; hiding the panel", e);
      siblingsWarned = true;
    }
  } finally {
    inFlight = false;
  }
  if (fetched) {
    const at = new Date();
    lastUpdated = el("time", undefined, at.toLocaleTimeString());
    lastUpdated.dateTime = at.toISOString();
    lastUpdated.title = at.toLocaleString();
  }
  const { siblings } = body;
  setNoticePlace(body.instance?.label ?? null);
  $("siblings").hidden = siblings.length === 0;
  const down = siblings.filter((s) => !s.healthy).length;
  // Text carries the status too, so the dot's color is never the only signal.
  $("siblings-summary").textContent =
    down > 0 ? `Other services · ${down} down` : `Other services · ${siblings.length} up`;
  $("siblings-dot").className = `dot ${down > 0 ? "down" : "up"}`;

  const matrix = buildSiblingMatrix(body);
  $("siblings-matrix").hidden = matrix === null;
  $("siblings-foot").hidden = matrix === null;
  $("siblings-heading").replaceChildren(
    matrix ? "Other services' databases. " : "Other services' databases. Opens their Ashurbanipal in a new tab. ",
    ...(lastUpdated ? ["Updated ", lastUpdated.cloneNode(true), "."] : []),
  );
  if (matrix) renderMatrix(matrix);
  else matrixShape = "";
  // An all-unlabelled config keeps the original new-tab list.
  $("siblings-list").replaceChildren(...(matrix ? matrix.unlabelled : siblings).map((s) => listRow(s, !matrix)));
}

function healthDot(healthy: boolean): HTMLElement {
  const dot = el("span", `dot ${healthy ? "up" : "down"}`);
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function listRow(s: Sibling, newTab: boolean): HTMLAnchorElement {
  const a = el("a");
  a.href = s.base_url;
  if (newTab) a.target = "_blank";
  a.rel = "noopener";
  a.className = "sibling-row";
  const dot = el("span", `dot ${s.healthy ? "up" : "down"}`);
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", s.healthy ? "healthy" : "unhealthy");
  const name = el("span", "sibling-name", s.name);
  name.title = s.name; // truncation escape hatch
  const state = el("span", "sibling-state", `${s.healthy ? "up" : "down"}${newTab ? " ↗" : ""}`);
  a.append(dot, name, state);
  return a;
}

function cellKey(name: string, label: string): string {
  return JSON.stringify([name, label]);
}

function shapeOf(m: SiblingMatrix): string {
  return JSON.stringify([m.labels, m.rows.map((r) => [r.name, r.cells.map((c) => c.kind)])]);
}

function stateText(healthy: boolean, sameView: boolean): string {
  return sameView ? "same view" : healthy ? "up" : "down";
}

function linkLabel(name: string, label: string, healthy: boolean, sameView: boolean): string {
  return `${name} in ${label}: ${sameView ? "same view, " : ""}${healthy ? "up" : "down"}`;
}

function renderCell(name: string, label: string, cell: MatrixCell): HTMLTableCellElement {
  const td = el("td");
  if (cell.kind === "here") {
    const here = el("span", "sibling-here", "you are here");
    here.setAttribute("aria-current", "page");
    td.append(here);
  } else if (cell.kind === "missing") {
    td.append(el("span", "sibling-missing", "not set up"));
  } else {
    const { sibling, sameView } = cell;
    const a = el("a", sameView ? "sibling-cell same" : "sibling-cell");
    a.href = sibling.base_url;
    a.rel = "noopener";
    a.setAttribute("aria-label", linkLabel(name, label, sibling.healthy, sameView));
    const dot = healthDot(sibling.healthy);
    const state = el("span", "sibling-state", stateText(sibling.healthy, sameView));
    a.append(dot, state);
    td.append(a);
    linkCells.set(cellKey(name, label), { a, dot, state });
    if (sameView) sameViewLinks.push({ a, base: sibling.base_url });
  }
  return td;
}

function renderMatrix(m: SiblingMatrix): void {
  const shape = shapeOf(m);
  if (shape === matrixShape) {
    for (const row of m.rows)
      row.cells.forEach((cell, i) => {
        if (cell.kind !== "link") return;
        const refs = linkCells.get(cellKey(row.name, m.labels[i]));
        if (!refs) return;
        refs.dot.className = `dot ${cell.sibling.healthy ? "up" : "down"}`;
        refs.state.textContent = stateText(cell.sibling.healthy, cell.sameView);
        refs.a.setAttribute("aria-label", linkLabel(row.name, m.labels[i], cell.sibling.healthy, cell.sameView));
        if (!cell.sameView) refs.a.href = cell.sibling.base_url;
      });
    refreshSameViewHrefs();
    return;
  }
  matrixShape = shape;
  linkCells.clear();
  sameViewLinks.length = 0;
  const corner = el("th");
  corner.append(el("span", "sr-only", "service"));
  $("siblings-matrix-head").replaceChildren(
    corner,
    ...m.labels.map((label) => {
      const th = el("th", undefined, label);
      th.scope = "col";
      return th;
    }),
  );
  $("siblings-matrix-body").replaceChildren(
    ...m.rows.map((row) => {
      const tr = el("tr", row.isInstance ? "instance" : undefined);
      const th = el("th");
      th.scope = "row";
      const name = el("span", "sibling-name", row.name);
      name.title = row.name; // truncation escape hatch
      th.append(name);
      if (row.isInstance) th.append(el("span", "sibling-me", "this service"));
      tr.append(th, ...row.cells.map((cell, i) => renderCell(row.name, m.labels[i], cell)));
      return tr;
    }),
  );
  refreshSameViewHrefs();
}

// The view changes under an open popover's links, so the hrefs follow it.
function refreshSameViewHrefs(): void {
  for (const { a, base } of sameViewLinks) a.href = sameViewHref(base, location.search);
}

$("siblings-pop").addEventListener("beforetoggle", (e) => {
  clearInterval(openTimer);
  if ((e as ToggleEvent).newState !== "open") return;
  refreshSameViewHrefs();
  refreshIfStale();
  openTimer = setInterval(refreshIfStale, FRESH_MS);
});
