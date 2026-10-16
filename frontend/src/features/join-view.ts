import { $ } from "../core/dom.js";
import { getAppliedJoin, hiddenColumnsForTable, state } from "../core/state.js";
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

// One band per table, above the column headers; spans follow the visible
// columns, so hiding every column of a table hides its band.
export function buildBands(columns: Column[]): HTMLTableRowElement | null {
  const def = getAppliedJoin();
  if (!def) return null;
  const tr = document.createElement("tr");
  tr.className = "bands";
  tr.appendChild(document.createElement("th")).className = "row-actions";
  const seen = new Set<number>();
  for (const col of columns) {
    if (col.join === undefined || seen.has(col.join)) continue;
    seen.add(col.join);
    const t = def.tables[col.join];
    const th = document.createElement("th");
    th.className = "band";
    th.dataset.band = String(col.join);
    th.textContent = t.alias === null ? t.table : `${t.table} ${t.alias}`;
    th.title = th.textContent;
    tr.appendChild(th);
  }
  return tr;
}

export function refreshBands(): void {
  for (const band of $("thead").querySelectorAll<HTMLElement>("th.band")) {
    const visible = $("thead").querySelectorAll(`th[data-join="${band.dataset.band}"]:not(.col-hidden)`).length;
    (band as HTMLTableCellElement).colSpan = Math.max(visible, 1);
    band.classList.toggle("col-hidden", visible === 0);
  }
}

export function joinHiddenCount(): number {
  return hiddenColumnsForTable().length;
}

// ---- the notice under the filter bar: a join-specific message with actions ----
export function showJoinNotice(text: string, actions: { label: string; run: () => void }[]): void {
  $("join-notice-text").textContent = text;
  $("join-notice-actions").replaceChildren(
    ...actions.map((a) => {
      const b = document.createElement("button");
      b.type = "button";
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
}
