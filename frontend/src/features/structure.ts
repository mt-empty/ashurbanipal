import { $ } from "../core/dom.js";
import type { ConstraintFk, ConstraintPk, ConstraintUnique, IndexInfo, TableData } from "../core/types.js";

// ---- structure dialog: indexes/constraints for the current table
// (story 26 prototype, docs/feature-backlog/26-index-and-constraint-metadata-panel.md).
// Pure renderer — no fetch, no cache: the data already arrived on the last
// /tables/data response (same as columns), so this only ever reads what
// getLastPayload() already has. Every row is plain text, not a button — no
// drill-in, per the read-only-FK decision. ----

function empty(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "refby-empty";
  p.textContent = text;
  return p;
}

function row(text: string, detail?: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "structure-row";
  div.textContent = text;
  if (detail) {
    const d = document.createElement("div");
    d.className = "structure-row-detail";
    d.textContent = detail;
    div.appendChild(d);
  }
  return div;
}

function renderIndexes(container: HTMLElement, indexes: IndexInfo[]): void {
  if (indexes.length === 0) {
    container.replaceChildren(empty("no indexes"));
    return;
  }
  container.replaceChildren(
    ...indexes.map((idx) => {
      const flags = idx.unique ? `unique, ${idx.method}` : idx.method;
      return row(`${idx.name}  (${idx.columns.join(", ")})  — ${flags}`, idx.predicate ? `WHERE ${idx.predicate}` : undefined);
    }),
  );
}

function renderPk(container: HTMLElement, pk: ConstraintPk | undefined): void {
  if (!pk) {
    container.replaceChildren(empty("no primary key"));
    return;
  }
  container.replaceChildren(row(`${pk.name ?? "(unnamed)"}  (${pk.columns.join(", ")})`));
}

function renderUnique(container: HTMLElement, unique: ConstraintUnique[]): void {
  if (unique.length === 0) {
    container.replaceChildren(empty("none"));
    return;
  }
  container.replaceChildren(...unique.map((u) => row(`${u.name}  (${u.columns.join(", ")})`)));
}

function renderForeignKeys(container: HTMLElement, fks: ConstraintFk[]): void {
  if (fks.length === 0) {
    container.replaceChildren(empty("none"));
    return;
  }
  container.replaceChildren(
    ...fks.map((fk) => {
      const target = fk.schema ? `${fk.schema}.${fk.table}` : fk.table;
      const pairing = `${fk.columns.map((c) => c.from).join(", ")} → ${target}(${fk.columns.map((c) => c.to).join(", ")})`;
      return row(`${fk.name}  ${pairing}`, `ON DELETE ${fk.on_delete}  ON UPDATE ${fk.on_update}`);
    }),
  );
}

function renderCheck(container: HTMLElement, check: { name: string; expression?: string }[]): void {
  if (check.length === 0) {
    container.replaceChildren(empty("none"));
    return;
  }
  container.replaceChildren(...check.map((c) => row(c.name, c.expression)));
}

export function renderStructure(data: TableData): void {
  renderIndexes($("structure-indexes"), data.indexes);
  renderPk($("structure-pk"), data.constraints.primary_key);
  renderUnique($("structure-unique"), data.constraints.unique);
  renderForeignKeys($("structure-fk"), data.constraints.foreign_keys);
  renderCheck($("structure-check"), data.constraints.check);
}
