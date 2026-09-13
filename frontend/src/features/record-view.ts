import { $, copyText } from "../core/dom.js";
import { state } from "../core/state.js";
import type { Column, Row } from "../core/types.js";
import { columnTypeClass, formatCellValue, rendersAsJson, warnBadJsonCell } from "../lib/format.js";
import { renderJsonTree } from "../lib/json-tree.js";
import { renderReferencedBy } from "./referenced-by.js";

// ---- record / vertical view: one already-fetched row as a stacked
// column:value list, for tables too wide to scan across ----
export function buildRecordEntries(columns: Column[], row: Row): Node[] {
  const nodes: Node[] = [];
  for (const col of columns) {
    const dt = document.createElement("dt");
    dt.textContent = col.name;
    const dd = document.createElement("dd");
    const raw = row[col.name];
    // Nothing to copy for a null field, but the grid's three-column
    // alignment still needs a cell here.
    let action: Node = document.createElement("span");
    if (raw == null) dd.textContent = "∅";
    else {
      if (rendersAsJson(col, raw)) {
        try {
          // Parse and render share one catch: a malformed tree build degrades
          // to plain text the same as unparseable JSON.
          dd.classList.add("json-tree");
          dd.appendChild(renderJsonTree(JSON.parse(raw)));
        } catch (e) {
          warnBadJsonCell(col, e);
          dd.textContent = raw;
        }
      } else dd.appendChild(formatCellValue(col, raw));
      const btn = document.createElement("button");
      btn.className = "copy";
      btn.setAttribute("aria-label", "copy cell value");
      btn.textContent = "⧉";
      btn.onclick = () => copyText(raw, btn);
      action = btn;
    }
    nodes.push(dt, dd, action);
  }
  return nodes;
}

// Parsed JSON or, when it won't parse, the raw string — so recordAsJson's copy
// still produces a usable document instead of throwing out of the click handler.
function parseJsonOrRaw(col: Column, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    warnBadJsonCell(col, e);
    return raw;
  }
}

// JSON columns are re-nested (the value is the engine's text-cast JSON string)
// so the copied JSON has real nested objects instead of an escaped string.
function recordAsJson(columns: Column[], row: Row): string {
  const obj: Record<string, unknown> = {};
  for (const col of columns) {
    const raw = row[col.name];
    obj[col.name] = raw != null && rendersAsJson(col, raw) ? parseJsonOrRaw(col, raw) : raw;
  }
  return JSON.stringify(obj, null, 2);
}

function recordAsInsert(columns: Column[], row: Row): string {
  // Identifiers left unquoted — no quote char is portable across all three engines.
  const target = state.schema ? `${state.schema}.${state.table}` : state.table;
  const cols = columns.map((c) => c.name).join(", ");
  const vals = columns.map((c) => sqlLiteral(c, row[c.name])).join(", ");
  return `INSERT INTO ${target} (${cols})\nVALUES (${vals});`;
}

// No boolean branch: bools text-cast as true/false on Postgres but 1/0 on
// MySQL/SQLite, and a quoted string inserts fine into a bool column on all three.
function sqlLiteral(col: Column, raw: string | null): string {
  if (raw == null) return "NULL";
  if (columnTypeClass(col.type) === "number" && /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "''")}'`;
}

export function openRecordView(columns: Column[], row: Row): void {
  $("record-dl").replaceChildren(...buildRecordEntries(columns, row));
  renderReferencedBy($("record-referenced-by"), row, () => $<HTMLDialogElement>("record-dialog").close());
  const copyRowBtn = $("record-copy-row");
  copyRowBtn.onclick = () => copyText(recordAsJson(columns, row), copyRowBtn);
  const copyInsertBtn = $("record-copy-insert");
  copyInsertBtn.onclick = () => copyText(recordAsInsert(columns, row), copyInsertBtn);
  const open = () => $<HTMLDialogElement>("record-dialog").showModal();
  document.startViewTransition ? document.startViewTransition(open) : open();
}
