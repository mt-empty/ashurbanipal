import { $, copyText, el } from "../core/dom.js";
import { qualifiedTable, state, tableInView, viewKey } from "../core/state.js";
import type { Column, ConstraintFk, JoinDef, Row, TableRef } from "../core/types.js";
import { compositeLabel, refTarget } from "../lib/column-key.js";
import { eqClause } from "../lib/filter-dsl.js";
import { columnTypeClass, formatCellValue, rendersAsJson, warnBadJsonCell } from "../lib/format.js";
import { recordJson } from "../lib/json-text.js";
import { renderJsonTree } from "../lib/json-tree.js";
import { copyButton, eqButton, fkLink, keyIcon, typeChip } from "./column-parts.js";
import { applyFilter } from "./filter-ui.js";
import { columnKey, displayName, tableGroups } from "./join-view.js";
import { renderReferencedBy } from "./referenced-by.js";
import { keyDescriptionOf, type TableMeta, tableMeta } from "./table-meta.js";
import { navigateWithSeededFilter } from "./view-history.js";

// ---- record / vertical view: one already-fetched row as a stacked
// column:value list, for tables too wide to scan across ----

const dialog = () => $<HTMLDialogElement>("record-dialog");

// A join row is grouped under one heading per table; a table row is one group.
function recordGroups(columns: Column[], def: JoinDef | undefined): { label?: string; columns: Column[] }[] {
  return def && columns.some((c) => c.join !== undefined) ? tableGroups(columns, def) : [{ columns }];
}

// What the dialog was opened for. `act` wraps a field's click: it closes the
// dialog, and runs only while that view is still the one in state.
interface RecordContext {
  def: JoinDef | undefined;
  meta: TableMeta | undefined;
  act: (run: () => void) => () => void;
}

// The muted line under a field: its comment, and where a foreign key points.
function fieldNote(col: Column, compositeFk: ConstraintFk | undefined): string {
  const where = col.references ? `references ${refTarget(col.references)}` : compositeFk && compositeLabel(compositeFk);
  return [col.comment, where].filter(Boolean).join(" · ");
}

function fieldValue(col: Column, raw: string, row: Row, { meta, act }: RecordContext): HTMLElement {
  const dd = el("dd");
  if (rendersAsJson(col, raw)) {
    try {
      // Parse and render share one catch: a malformed tree build degrades
      // to plain text the same as unparseable JSON.
      dd.appendChild(renderJsonTree(JSON.parse(raw)));
      dd.classList.add("json-tree");
    } catch (e) {
      warnBadJsonCell(col, e);
      dd.replaceChildren(formatCellValue(col, raw));
    }
    return dd;
  }
  const value = formatCellValue(col, raw);
  const link = fkLink(col, raw, row, meta);
  if (!link) {
    dd.appendChild(value);
    return dd;
  }
  const btn = el("button", "fk-cell record-link");
  btn.type = "button";
  btn.title = link.title;
  btn.appendChild(value);
  btn.onclick = act(() => navigateWithSeededFilter(link.target, link.clause));
  dd.appendChild(btn);
  return dd;
}

// On a span, not the dd: the field's note joins the dd and keeps its own hover.
function nullValue(): HTMLElement {
  const mark = el("span", "cell-null", "∅");
  mark.title = "null";
  const dd = el("dd");
  dd.appendChild(mark);
  return dd;
}

function fieldActions(col: Column, raw: string | null, { def, act }: RecordContext): HTMLElement {
  const acts = el("span", "record-acts");
  const eq = eqClause(columnKey(col, def), raw);
  if (eq !== null)
    acts.appendChild(
      eqButton(
        raw == null,
        act(() => applyFilter(eq)),
      ),
    );
  if (raw != null) acts.appendChild(copyButton(raw));
  return acts;
}

function buildRecordEntries(columns: Column[], row: Row, ctx: RecordContext): Node[] {
  const { def, meta } = ctx;
  const nodes: Node[] = [];
  for (const group of recordGroups(columns, def)) {
    if (group.label !== undefined) {
      const heading = el("dt", "record-group", group.label);
      heading.title = group.label;
      nodes.push(heading);
    }
    for (const col of group.columns) {
      const key = keyDescriptionOf(col, meta);
      const dt = el("dt");
      const name = el("span", "record-name", displayName(col));
      name.title = columnKey(col, def);
      dt.append(name, typeChip(col));
      const raw = row[col.name];
      const dd = raw == null ? nullValue() : fieldValue(col, raw, row, ctx);
      const note = fieldNote(col, meta?.compositeFkOf.get(col.name));
      if (note) dd.appendChild(el("span", "record-note", note));
      const field = [keyIcon(key), dt, dd, fieldActions(col, raw, ctx)];
      // Tests and anything else find a field by its column, not its position.
      for (const part of field) part.dataset.col = col.name;
      nodes.push(...field);
    }
  }
  return nodes;
}

// Nested exactly when the record view draws it as a tree, so copy matches
// what is on screen. Invalid JSON stays a string, so the copy is still a
// usable document.
function parsesAsJsonCell(col: Column, raw: string): boolean {
  if (!rendersAsJson(col, raw)) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch (e) {
    warnBadJsonCell(col, e);
    return false;
  }
}

function recordAsJson(columns: Column[], row: Row): string {
  return recordJson(
    columns.map((col) => {
      const raw = row[col.name];
      return { name: col.name, raw, json: raw != null && parsesAsJsonCell(col, raw) };
    }),
  );
}

function recordAsInsert(table: TableRef, columns: Column[], row: Row): string {
  // Identifiers left unquoted — no quote char is portable across all three engines.
  const target = qualifiedTable(table);
  const cols = columns.map((c) => c.name).join(", ");
  const vals = columns.map((c) => sqlLiteral(c, row[c.name])).join(", ");
  return `INSERT INTO ${target} (${cols})\nVALUES (${vals});`;
}

// No boolean branch: bools text-cast as true/false on Postgres but 1/0 on
// MySQL/SQLite, and a quoted string inserts fine into a bool column on all three.
function sqlLiteral(col: Column, raw: string | null): string {
  if (raw == null) return "NULL";
  if (columnTypeClass(col) === "number" && /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "''")}'`;
}

// `rows` is the page as it was when the dialog opened; `def` is the join it
// was rendered for, which state.view may have moved on from.
export function openRecordView(columns: Column[], rows: Row[], index: number, def: JoinDef | undefined): void {
  // Both name one table; a join row has several.
  const table = tableInView();
  $("record-referenced-by-wrap").hidden = table === null;
  const copyInsertBtn = $<HTMLButtonElement>("record-copy-insert");
  copyInsertBtn.hidden = table === null;
  const copyRowBtn = $<HTMLButtonElement>("record-copy-row");
  const prev = $<HTMLButtonElement>("record-prev");
  const next = $<HTMLButtonElement>("record-next");
  const view = viewKey(state.view);
  const ctx: RecordContext = {
    def,
    meta: tableMeta(table),
    act: (run) => () => {
      dialog().close();
      if (viewKey(state.view) === view) run();
    },
  };
  const show = (i: number) => {
    const row = rows[i];
    $("record-dl").replaceChildren(...buildRecordEntries(columns, row, ctx));
    $("record-pos").textContent = `${i + 1} of ${rows.length}`;
    // A disabled button drops focus, so at an end it moves to the other one.
    const focused = document.activeElement;
    prev.disabled = i === 0;
    next.disabled = i === rows.length - 1;
    if (focused === next && next.disabled) prev.focus();
    if (focused === prev && prev.disabled) next.focus();
    prev.onclick = () => show(i - 1);
    next.onclick = () => show(i + 1);
    if (table !== null) {
      renderReferencedBy($("record-referenced-by"), row, () => dialog().close());
      copyInsertBtn.onclick = () => copyText(recordAsInsert(table, columns, row), copyInsertBtn);
    }
    copyRowBtn.onclick = () => copyText(recordAsJson(columns, row), copyRowBtn);
  };
  show(index);
  const open = () => dialog().showModal();
  document.startViewTransition ? document.startViewTransition(open) : open();
}
