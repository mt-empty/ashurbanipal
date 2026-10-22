import { api } from "../core/api.js";
import { $, el } from "../core/dom.js";
import type { SiblingsResponse } from "../core/types.js";
import {
  buildSiblingMatrix,
  isOwnEntry,
  type ListedSibling,
  listSiblings,
  type MatrixCell,
  type SiblingMatrix,
  sameViewHref,
} from "../lib/sibling-matrix.js";
import { setNoticePlace } from "./view-notice.js";

// Each fetch makes the server health-check every sibling, so the list is
// fetched once at load (the pill and the fallback note need it), then only
// while the pop-up is open and the tab visible, and never when the last
// result is younger than this.
const FRESH_MS = 15_000;
// A fetch that hangs past this is abandoned, so it can't block the next one.
const FETCH_TIMEOUT_MS = 10_000;
// A failed fetch retries on its own, backing off to this, so a closed pop-up
// (or a pill hidden because the first fetch failed) still recovers.
const MAX_RETRY_MS = 60_000;

let lastFetchStarted = Number.NEGATIVE_INFINITY;
let inFlight = false;
let openTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = FRESH_MS;
// Warn once per outage, not on every refresh; re-armed on the next success.
let siblingsWarned = false;

type LinkCell = Extract<MatrixCell, { kind: "link" }>;
type LinkRef = { a: HTMLAnchorElement; dot: HTMLElement; state: HTMLElement };
// The rendered matrix's shape and its link elements in render order, so a
// refresh that changes only health repaints cells in place and keeps focus.
let matrixShape = "";
let linkRefs: LinkRef[] = [];
let linkCells: { name: string; label: string; cell: LinkCell }[] = [];
// The same for the plain list, so a refresh keeps focus there too.
type RowRef = LinkRef & { name: HTMLElement; note: HTMLElement };
let listShape = "";
let rowRefs: RowRef[] = [];

export function startSiblings(): void {
  void loadSiblings();
  // A hidden tab skips the refresh; coming back to it catches up if the
  // pop-up is open or a retry is owed.
  document.addEventListener("visibilitychange", () => {
    if (retryTimer !== undefined || $("siblings-pop").matches(":popover-open")) refreshIfStale();
  });
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(refreshIfStale, retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
}

function refreshIfStale(): void {
  if (document.hidden || inFlight || performance.now() - lastFetchStarted < FRESH_MS) return;
  void loadSiblings();
}

async function loadSiblings(): Promise<void> {
  inFlight = true;
  lastFetchStarted = performance.now();
  let body: SiblingsResponse | undefined;
  try {
    // no-store: Chrome otherwise queues an identical GET behind one still in
    // flight, for up to 20 s.
    body = await api<SiblingsResponse>("/siblings", {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    siblingsWarned = false;
  } catch (e) {
    if (!siblingsWarned) {
      console.warn("ashurbanipal: /siblings fetch failed; retrying", e);
      siblingsWarned = true;
    }
  } finally {
    inFlight = false;
  }
  // A failure keeps whatever was last shown; only a retry can replace it.
  if (!body) {
    scheduleRetry();
    return;
  }
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = FRESH_MS;
  render(body);
}

function stampHeading(prefix: string): void {
  const at = new Date();
  const updated = el("time", undefined, at.toLocaleTimeString());
  updated.dateTime = at.toISOString();
  updated.title = at.toLocaleString();
  $("siblings-heading").replaceChildren(prefix, "Updated ", updated, ".");
}

function renderWarnings(warnings: string[]): void {
  $("siblings-warnings").hidden = warnings.length === 0;
  $("siblings-warnings").replaceChildren(
    ...warnings.map((w) => {
      const li = el("li");
      const icon = el("span", "sibling-warning-icon", "⚠");
      icon.setAttribute("aria-hidden", "true");
      li.append(icon, el("span", "sibling-warning-text", `Config: ${w}`));
      return li;
    }),
  );
}

function render(body: SiblingsResponse): void {
  const { siblings } = body;
  setNoticePlace(body.instance?.label ?? null);
  // The instance's own entry is in the list for its position, not its health.
  const others = siblings.filter((s) => !isOwnEntry(body.instance, s));
  $("siblings").hidden = others.length === 0;
  const down = others.filter((s) => !s.healthy).length;
  const warnings = body.warnings ?? [];
  $("siblings-summary").textContent = [
    "Other services",
    down > 0 ? `${down} down` : `${others.length} up`,
    ...(warnings.length > 0 ? [`${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`] : []),
  ].join(" · ");
  $("siblings-dot").className = dotClass(down === 0);
  renderWarnings(warnings);

  const matrix = buildSiblingMatrix(body);
  $("siblings-matrix").hidden = matrix === null;
  $("siblings-foot").hidden = matrix === null;
  stampHeading(
    matrix ? "Other services' databases. " : "Other services' databases. Opens their Ashurbanipal in a new tab. ",
  );
  if (matrix) renderMatrix(matrix);
  else matrixShape = "";
  // With no labels at all, the plain list opens each service in a new tab.
  renderList(matrix ? matrix.listed : listSiblings(siblings), !matrix);
}

function renderList(list: ListedSibling[], newTab: boolean): void {
  const shape = JSON.stringify([newTab, list.map((l) => [l.sibling.name, l.note])]);
  if (shape !== listShape) {
    listShape = shape;
    rowRefs = list.map(() => listRow(newTab));
    $("siblings-list").replaceChildren(...rowRefs.map((r) => r.a));
  }
  list.forEach((l, i) => {
    paintRow(rowRefs[i], l, newTab);
  });
}

// Health is always in the text too, so the dot's colour is never the only signal.
function health(healthy: boolean): string {
  return healthy ? "up" : "down";
}

function dotClass(healthy: boolean): string {
  return `dot ${health(healthy)}`;
}

// Without `ariaLabel` the dot is decoration beside text that already says the health.
function healthDot(healthy: boolean, ariaLabel?: string): HTMLElement {
  const dot = el("span", dotClass(healthy));
  if (ariaLabel === undefined) dot.setAttribute("aria-hidden", "true");
  else {
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", ariaLabel);
  }
  return dot;
}

function listRow(newTab: boolean): RowRef {
  const a = el("a", "sibling-row");
  if (newTab) a.target = "_blank";
  a.rel = "noopener";
  const ref: RowRef = {
    a,
    dot: healthDot(true, ""),
    name: el("span", "sibling-name"),
    note: el("span", "sibling-note"),
    state: el("span", "sibling-state"),
  };
  a.append(ref.dot, ref.name, ref.note, ref.state);
  return ref;
}

function paintRow(ref: RowRef, { sibling: s, note }: ListedSibling, newTab: boolean): void {
  ref.a.href = s.base_url;
  ref.name.textContent = s.name;
  ref.name.title = s.name; // truncation escape hatch
  ref.note.textContent = note ?? "";
  ref.note.hidden = note === undefined;
  ref.dot.className = dotClass(s.healthy);
  ref.dot.setAttribute("aria-label", s.healthy ? "healthy" : "unhealthy");
  ref.state.textContent = `${health(s.healthy)}${newTab ? " ↗" : ""}`;
}

function shapeOf(m: SiblingMatrix): string {
  return JSON.stringify([m.labels, m.ownLabel, m.rows.map((r) => [r.name, r.cells.map((c) => c.kind)])]);
}

function paintLink(ref: LinkRef, name: string, label: string, { sibling, sameView }: LinkCell): void {
  const state = sameView ? `same view · ${health(sibling.healthy)}` : health(sibling.healthy);
  ref.dot.className = dotClass(sibling.healthy);
  ref.state.textContent = state;
  ref.a.setAttribute("aria-label", `${name} in ${label}: ${state}`);
  ref.a.href = sameView ? sameViewHref(sibling.base_url, location.search) : sibling.base_url;
}

function renderCell(cell: MatrixCell): HTMLTableCellElement {
  const td = el("td");
  if (cell.kind === "here") {
    const here = el("span", "sibling-here", "you are here");
    here.setAttribute("aria-current", "page");
    td.append(here);
  } else if (cell.kind === "missing") {
    td.append(el("span", "sibling-missing", "not set up"));
  } else {
    const a = el("a", cell.sameView ? "sibling-cell same" : "sibling-cell");
    a.rel = "noopener";
    const ref: LinkRef = { a, dot: healthDot(cell.sibling.healthy), state: el("span", "sibling-state") };
    a.append(ref.dot, ref.state);
    td.append(a);
    linkRefs.push(ref);
  }
  return td;
}

function renderMatrix(m: SiblingMatrix): void {
  linkCells = m.rows.flatMap((row) =>
    row.cells.flatMap((cell, i) => (cell.kind === "link" ? [{ name: row.name, label: m.labels[i], cell }] : [])),
  );
  const shape = shapeOf(m);
  if (shape !== matrixShape) {
    matrixShape = shape;
    linkRefs = [];
    const corner = el("th");
    corner.append(el("span", "sr-only", "service"));
    $("siblings-matrix-head").replaceChildren(
      corner,
      ...m.labels.map((label) => {
        const th = el("th", label === m.ownLabel ? "mine" : undefined, label);
        th.scope = "col";
        return th;
      }),
    );
    $("siblings-matrix-body").replaceChildren(
      ...m.rows.map((row) => {
        const tr = el("tr", row.isInstance ? "instance" : undefined);
        const th = el("th", row.isInstance ? "mine" : undefined);
        th.scope = "row";
        const name = el("span", "sibling-name", row.name);
        name.title = row.name; // truncation escape hatch
        th.append(name);
        if (row.isInstance) th.append(el("span", "sibling-me", "this service"));
        tr.append(th, ...row.cells.map(renderCell));
        return tr;
      }),
    );
  }
  repaintLinks();
}

// A same-view link carries the page's current query, which changes under an open pop-up.
function repaintLinks(): void {
  linkCells.forEach(({ name, label, cell }, i) => {
    paintLink(linkRefs[i], name, label, cell);
  });
}

$("siblings-pop").addEventListener("beforetoggle", (e) => {
  clearInterval(openTimer);
  if ((e as ToggleEvent).newState !== "open") return;
  repaintLinks();
  refreshIfStale();
  openTimer = setInterval(refreshIfStale, FRESH_MS);
});
