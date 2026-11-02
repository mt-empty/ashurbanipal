import { copyText, el } from "../core/dom.js";
import type { Column, Row } from "../core/types.js";
import { fkTarget, type KeyDescription, refTarget } from "../lib/column-key.js";
import { filterClause, filterClauses, filterTooLong } from "../lib/filter-dsl.js";
import type { TableMeta } from "./table-meta.js";

// ---- what the grid, the record view and the suggestion list draw alike
// for a column. Callers do the navigating and filtering: suggest-list sits
// under filter-ui, so this module stays free of their imports. ----

// A column's key icon; null keeps an empty slot so names line up. Decorative:
// callers put the key's text in a title or label.
export function keyIcon(key: KeyDescription | null): HTMLElement {
  const icon = el("span", "key-icon", key?.icon ?? "");
  icon.setAttribute("aria-hidden", "true");
  if (key) icon.title = key.label;
  return icon;
}

// The engine's own type spelling; a long one ellipsizes, so the title carries it (R8).
export function typeChip(col: Column): HTMLElement {
  const chip = el("code", "col-type", col.type);
  chip.title = col.type;
  return chip;
}

export interface FkLink {
  title: string;
  table: string;
  schema: string | undefined;
  clause: string;
}

// Where a foreign key value leads: its single-column reference, or every pair
// of a composite key (from `meta`, so table views only). Null when a composite
// member is null, or the filter would not fit.
export function fkLink(col: Column, raw: string, row: Row, meta: TableMeta | undefined): FkLink | null {
  const ref = col.references;
  if (ref) {
    const clause = filterClause(ref.column, "=", raw);
    if (filterTooLong(clause)) return null;
    return { title: `go to ${refTarget(ref)} = ${raw}`, table: ref.table, schema: ref.schema, clause };
  }
  const fk = meta?.compositeFkOf.get(col.name);
  if (!fk?.columns.every((c) => row[c.from] != null)) return null;
  const clause = filterClauses(fk.columns.map((c) => ({ column: c.to, value: row[c.from] as string })));
  if (filterTooLong(clause)) return null;
  return { title: `go to ${fkTarget(fk)} where ${clause}`, table: fk.table, schema: fk.schema, clause };
}

// The `=` and copy buttons beside a value; the grid's non-null cells clone
// the same markup from #cell-template.
export function eqButton(isNull: boolean, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const btn = el("button", "filter-eq", "=");
  btn.type = "button";
  btn.setAttribute("aria-label", isNull ? "filter by null" : "filter by this value");
  btn.onclick = onClick;
  return btn;
}

export function copyButton(raw: string): HTMLButtonElement {
  const btn = el("button", "copy");
  btn.type = "button";
  btn.setAttribute("aria-label", "copy cell value");
  btn.append(el("span", "copy-icon", "⧉"));
  btn.onclick = (e) => {
    e.stopPropagation();
    copyText(raw, btn);
  };
  return btn;
}
