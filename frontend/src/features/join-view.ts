import { $ } from "../core/dom.js";
import { getAppliedJoin, state } from "../core/state.js";
import type { Column } from "../core/types.js";
import { effectiveName, quoteJoinName } from "../lib/join-dsl.js";

export function inJoinView(): boolean {
  return state.join !== "";
}

// How a column is named where the user types or links it (sort, filter clause):
// `alias.column` in a join view, the plain name otherwise.
export function columnKey(col: Column): string {
  const def = getAppliedJoin();
  if (!def || col.join === undefined || col.column === undefined) return col.name;
  return `${quoteJoinName(effectiveName(def.tables[col.join]))}.${col.column}`;
}

const QUALIFIED = /^(?:([A-Za-z_][A-Za-z0-9_]*)|"((?:[^"]|"")+)")\.(.+)$/s;

// Inverse of columnKey, resolved against the applied join's aliases.
export function splitColumnKey(key: string): { join: number; column: string } | null {
  const def = getAppliedJoin();
  const m = QUALIFIED.exec(key);
  if (!def || !m) return null;
  const alias = m[1] ?? m[2].replaceAll('""', '"');
  const join = def.tables.findIndex((t) => effectiveName(t) === alias);
  return join < 0 ? null : { join, column: m[3] };
}

// One band per run of neighbouring columns of the same table, above the column
// headers; spans follow the visible columns, so hiding every column of a run
// hides its band. A select list that alternates tables gets a band per switch.
export function buildBands(columns: Column[]): HTMLTableRowElement | null {
  const def = getAppliedJoin();
  if (!def) return null;
  const tr = document.createElement("tr");
  tr.className = "bands";
  tr.appendChild(document.createElement("th")).className = "row-actions";
  let band: HTMLTableCellElement | null = null;
  columns.forEach((col, i) => {
    if (col.join === undefined) return;
    if (band && band.dataset.band === String(col.join)) {
      band.dataset.end = String(i);
      return;
    }
    const t = def.tables[col.join];
    band = document.createElement("th");
    band.className = "band";
    band.dataset.band = String(col.join);
    band.dataset.start = String(i);
    band.dataset.end = String(i);
    const pill = document.createElement("span");
    pill.className = "band-pill";
    pill.textContent = t.alias === null ? t.table : `${t.table} ${t.alias}`;
    pill.title = pill.textContent;
    band.appendChild(pill);
    tr.appendChild(band);
  });
  return tr;
}

export function refreshBands(): void {
  const heads = [...$("thead").querySelectorAll<HTMLElement>("th[data-join]")];
  for (const band of $("thead").querySelectorAll<HTMLTableCellElement>("th.band")) {
    const from = Number(band.dataset.start);
    const to = Number(band.dataset.end);
    const visible = heads.slice(from, to + 1).filter((h) => !h.classList.contains("col-hidden")).length;
    band.colSpan = Math.max(visible, 1);
    band.classList.toggle("col-hidden", visible === 0);
  }
}

// ---- the notice under the filter bar: a join-specific message with actions ----
export function showJoinNotice(text: string, actions: { label: string; run: () => void }[]): void {
  $("join-notice-text").textContent = text;
  $("join-notice-actions").replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement("button");
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
  const join = inJoinView();
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
  const box = document.createElement("div");
  box.className = "empty-join";
  const title = document.createElement("p");
  title.textContent = "No rows match this join.";
  const why = document.createElement("p");
  why.className = "muted-note";
  why.textContent = "An inner join drops rows without a match. A left join keeps them.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = "Switch to left join";
  btn.onclick = onLeft;
  box.append(title, why, btn);
  return box;
}
