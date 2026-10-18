import { $, el } from "../core/dom.js";
import { joinInView } from "../core/state.js";
import type { Column, JoinDef } from "../core/types.js";
import { effectiveName, quoteJoinName } from "../lib/join-dsl.js";

// The filter DSL reads a bare AND, OR or NOT as a keyword, so a join alias spelled so is quoted there.
const filterQualifier = (name: string): string => (/^(AND|OR|NOT)$/i.test(name) ? `"${name}"` : quoteJoinName(name));

// How a column is named where the user types or links it (sort, filter clause):
// `alias.column` in a join view, the plain name otherwise.
export function columnKey(col: Column): string {
  const def = joinInView()?.def;
  if (!def || col.join === undefined || col.column === undefined) return col.name;
  return `${filterQualifier(effectiveName(def.tables[col.join]))}.${col.column}`;
}

const QUALIFIED = /^(?:([A-Za-z_][A-Za-z0-9_]*)|"((?:[^"]|"")+)")\.(.+)$/s;

// Inverse of columnKey, resolved against the applied join's aliases.
export function splitColumnKey(key: string, def: JoinDef): { join: number; column: string } | null {
  const m = QUALIFIED.exec(key);
  if (!def || !m) return null;
  const alias = m[1] ?? m[2].replaceAll('""', '"');
  const join = def.tables.findIndex((t) => effectiveName(t) === alias);
  return join < 0 ? null : { join, column: m[3] };
}

// One band per run of neighbouring columns of the same table, above the column
// headers; each header carries its run's `data-run`, so a band spans the visible
// headers of its run and hides with the last of them. A select list that
// alternates tables gets a band per switch.
export function buildBands(columns: Column[], heads: readonly HTMLElement[]): HTMLTableRowElement | null {
  const def = joinInView()?.def;
  if (!def) return null;
  const tr = el("tr", "bands");
  tr.appendChild(el("th", "row-actions"));
  let band: HTMLTableCellElement | null = null;
  columns.forEach((col, i) => {
    if (col.join === undefined) return;
    if (band?.dataset.band !== String(col.join)) {
      const t = def.tables[col.join];
      band = el("th", "band");
      band.dataset.band = String(col.join);
      band.dataset.run = String(tr.cells.length);
      const pill = el("span", "band-pill", t.alias === null ? t.table : `${t.table} ${t.alias}`);
      pill.title = pill.textContent;
      band.appendChild(pill);
      tr.appendChild(band);
    }
    heads[i].dataset.run = band.dataset.run;
  });
  return tr;
}

export function refreshBands(): void {
  const thead = $("thead");
  for (const band of thead.querySelectorAll<HTMLTableCellElement>("th.band")) {
    const visible = thead.querySelectorAll(`th[data-join][data-run="${band.dataset.run}"]:not(.col-hidden)`).length;
    band.colSpan = Math.max(visible, 1);
    band.classList.toggle("col-hidden", visible === 0);
  }
}

// ---- the notice under the filter bar: a join-specific message with actions ----
export function showJoinNotice(text: string, actions: { label: string; run: () => void }[]): void {
  $("join-notice-text").textContent = text;
  $("join-notice-actions").replaceChildren(
    ...actions.map((a) => {
      const b = el("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = a.label;
      b.onclick = a.run;
      return b;
    }),
  );
  $("join-notice").hidden = false;
}

export function clearJoinNotice(): void {
  $("join-notice").hidden = true;
}

// `⋈ join` starts a join from the table being viewed; inside a join view
// `edit join` changes it instead.
export function updateJoinChrome(): void {
  const join = joinInView() !== null;
  $<HTMLButtonElement>("join-btn").hidden = join;
  $<HTMLButtonElement>("join-btn").disabled = false;
  $<HTMLButtonElement>("join-edit-btn").hidden = !join;
  $<HTMLButtonElement>("join-link-btn").hidden = !join;
  // Both describe one table; the board's join view keeps edit, link, refresh and columns.
  $("structure-btn").hidden = join;
  $("payload").hidden = join;
}

// The grid's empty state for an INNER join that matched nothing (board T4).
export function buildEmptyJoin(onLeft: () => void): HTMLElement {
  const box = el("div", "empty-join");
  const title = el("p");
  title.textContent = "No rows match this join.";
  const why = el("p", "muted-note", "An inner join drops rows without a match. A left join keeps them.");
  const btn = el("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = "Switch to left join";
  btn.onclick = onLeft;
  box.append(title, why, btn);
  return box;
}
