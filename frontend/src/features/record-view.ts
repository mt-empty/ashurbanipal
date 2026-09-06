import { $, copyText } from "../core/dom.js";
import { state } from "../core/state.js";
import type { Column, Row } from "../core/types.js";
import { formatCellValue } from "../lib/format.js";
import { renderJsonTree } from "../lib/json-tree.js";

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
      if (col.type === "jsonb") {
        try {
          // Parse and render share one catch: a malformed tree build degrades
          // to plain text the same as unparseable JSON.
          dd.classList.add("json-tree");
          dd.appendChild(renderJsonTree(JSON.parse(raw)));
        } catch (e) {
          warnBadJsonb(col.name, e);
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

// The backend declared this column jsonb but the ::text value isn't parseable
// JSON — surface the protocol violation the plain-text fallback would hide.
function warnBadJsonb(colName: string, e: unknown): void {
  console.warn(`ashurbanipal: jsonb column ${colName} is not valid JSON`, e);
}

// jsonb value or, when it won't parse, the raw string — so recordAsJson's copy
// still produces a usable document instead of throwing out of the click handler.
function parseJsonbOrRaw(colName: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    warnBadJsonb(colName, e);
    return raw;
  }
}

// jsonb columns are re-nested (raw value is the ::text-cast JSON string)
// so the copied JSON has real nested objects instead of an escaped string.
function recordAsJson(columns: Column[], row: Row): string {
  const obj: Record<string, unknown> = {};
  for (const col of columns) {
    const raw = row[col.name];
    obj[col.name] = col.type === "jsonb" && raw != null ? parseJsonbOrRaw(col.name, raw) : raw;
  }
  return JSON.stringify(obj, null, 2);
}

// Deliberately loose — the three backends spell numeric types differently;
// a stray hit (e.g. "point" matches "int") is caught by the value check below.
const NUMERIC_TYPE_RE = /int|serial|numeric|decimal|real|double|float|^number/i;

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
  if (NUMERIC_TYPE_RE.test(col.type) && /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "''")}'`;
}

export function openRecordView(columns: Column[], row: Row): void {
  $("record-dl").replaceChildren(...buildRecordEntries(columns, row));
  const copyRowBtn = $("record-copy-row");
  copyRowBtn.onclick = () => copyText(recordAsJson(columns, row), copyRowBtn);
  const copyInsertBtn = $("record-copy-insert");
  copyInsertBtn.onclick = () => copyText(recordAsInsert(columns, row), copyInsertBtn);
  const open = () => $<HTMLDialogElement>("record-dialog").showModal();
  document.startViewTransition ? document.startViewTransition(open) : open();
}
