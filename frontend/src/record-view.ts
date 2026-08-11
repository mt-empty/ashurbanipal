import { $, copyText } from "./dom.js";
import { formatCellValue } from "./grid.js";
import { renderJsonTree } from "./json-tree.js";
import type { Column, Row } from "./types.js";

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
          dd.classList.add("json-tree");
          dd.appendChild(renderJsonTree(JSON.parse(raw)));
        } catch { dd.textContent = raw; }
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

// jsonb columns are re-nested (raw value is the ::text-cast JSON string)
// so the copied JSON has real nested objects instead of an escaped string.
function recordAsJson(columns: Column[], row: Row): string {
  const obj: Record<string, unknown> = {};
  for (const col of columns) {
    const raw = row[col.name];
    obj[col.name] = col.type === "jsonb" && raw != null ? JSON.parse(raw) : raw;
  }
  return JSON.stringify(obj, null, 2);
}

export function openRecordView(columns: Column[], row: Row): void {
  $("record-dl").replaceChildren(...buildRecordEntries(columns, row));
  const copyRowBtn = $("record-copy-row");
  copyRowBtn.onclick = () => copyText(recordAsJson(columns, row), copyRowBtn);
  const open = () => $<HTMLDialogElement>("record-dialog").showModal();
  document.startViewTransition ? document.startViewTransition(open) : open();
}
