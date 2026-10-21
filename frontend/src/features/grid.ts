import { loadData } from "../bootstrap/reload.js";
import { $, copyText, el, qs } from "../core/dom.js";
import { hiddenColumns, joinInView, rememberSort, setHiddenColumns, state, tableInView } from "../core/state.js";
import type { Column, Row, ViewData } from "../core/types.js";
import {
  APPROX_COUNT_TITLE,
  formatApproxCount,
  formatCellValue,
  rendersAsJson,
  warnBadJsonCell,
} from "../lib/format.js";
import { type JsonValue, renderJsonTree } from "../lib/json-tree.js";
import { rowKey } from "../lib/row-diff.js";
import { columnMinWidth } from "./column-widths.js";
import { applyFilterClause, showCommonValues } from "./filter-ui.js";
import { switchToLeftJoin } from "./join-dialog.js";
import { buildBands, buildEmptyJoin, columnKey, refreshBands } from "./join-view.js";
import { navigateWithSeededFilter } from "./nav.js";
import { openRecordView } from "./record-view.js";
import { openReferencedByPopover } from "./referenced-by.js";

// A focusable control nested in the sortable th — stopPropagation so
// opening it doesn't also toggle sort.
function commonValuesButton(table: string, column: string): HTMLButtonElement {
  const btn = el("button");
  btn.type = "button";
  btn.className = "common-values-btn";
  btn.setAttribute("aria-label", `common values for ${column}`);
  btn.textContent = "▾";
  btn.onclick = (e) => {
    e.stopPropagation();
    showCommonValues(e, table, column);
  };
  return btn;
}

export function renderHeader(columns: Column[]): void {
  const hidden = hiddenColumns();
  // Common values are a per-table query; a join column has no single table to ask.
  const table = tableInView();
  const tr = el("tr");
  const actionsTh = el("th", "row-actions");
  tr.appendChild(actionsTh);
  for (const col of columns) {
    const th = el("th");
    th.dataset.col = col.name;
    if (col.join !== undefined) th.dataset.join = String(col.join);
    const minWidth = columnMinWidth(col.name);
    if (minWidth) th.style.minWidth = `${minWidth}px`;
    if (hidden.includes(col.name)) th.classList.add("col-hidden");
    const label = `${col.name} (${col.type})`;
    // The visible header renders the engine-native type spelling as inline
    // code; `label` stays the plain-text form for the aria-label only.
    const typeCode = el("code", "col-type", col.type);
    typeCode.title = col.type; // the chip ellipsizes a long spelling (R8)
    // Name, ▾ and the sort arrow share one line; the type chip sits under it.
    const head = el("span", "th-name");
    // Capped in CSS (a 63-char identifier would otherwise set the column's
    // width); the title is the escape hatch (R8).
    const nameEl = el("span", "col-name", col.name);
    nameEl.title = col.comment ? `${col.name} — ${col.comment}` : col.name;
    if (col.key === "pk" || col.key === "fk") {
      // A column can be its own table's PK and an FK at once (1:1 detail
      // table shape) — key still reports "pk", but references is populated
      // too (spec/protocol.md §5.4.1), so the label surfaces both facts.
      const keyLabel =
        col.key === "pk"
          ? col.references
            ? `primary key, also references ${col.references.table}.${col.references.column}`
            : "primary key"
          : `foreign key, references ${col.references.table}.${col.references.column}`;
      const icon = el("span", "key-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.title = keyLabel;
      icon.textContent = col.key === "pk" ? "🔑" : "🔗";
      head.append(icon, nameEl, " ");
      // Layers onto the accessible name rather than replacing the key
      // description — the icon keeps its own `title` above.
      th.setAttribute("aria-label", col.comment ? `${label}, ${keyLabel}, ${col.comment}` : `${label}, ${keyLabel}`);
    } else {
      head.append(nameEl, " ");
    }
    if (col.comment) th.title = col.comment;
    const sortKey = columnKey(col);
    th.setAttribute(
      "aria-sort",
      sortKey === state.sort ? (state.order === "desc" ? "descending" : "ascending") : "none",
    );
    th.onclick = () => {
      state.order = state.sort === sortKey && state.order === "asc" ? "desc" : "asc";
      state.sort = sortKey;
      state.offset = 0;
      rememberSort();
      loadData({ resetScroll: false });
    };
    if (table !== null) head.appendChild(commonValuesButton(table, col.name));
    th.append(head, typeCode);
    tr.appendChild(th);
  }
  const bands = buildBands(columns, [...tr.cells].slice(1));
  $("thead").replaceChildren(...(bands ? [bands, tr] : [tr]));
  if (bands) refreshBands();
}

function renderEmptyState(columnCount: number): void {
  const emptyRow = el("tr", "empty");
  const td = el("td");
  td.colSpan = columnCount;
  const join = joinInView();
  if (join && state.offset === 0 && state.filter === "" && join.def.joins.some((j) => j.type === "inner")) {
    td.appendChild(buildEmptyJoin(switchToLeftJoin));
  } else td.textContent = state.offset > 0 ? "No more rows." : "No rows match this view.";
  emptyRow.appendChild(td);
  $("tbody").replaceChildren(emptyRow);
}

const cellTemplate = $<HTMLTemplateElement>("cell-template");
const rowActionTemplate = $<HTMLTemplateElement>("row-action-template");

// ---- cell preview ----
let cellPopAnchor: HTMLElement | null = null;
function showCellPop(e: MouseEvent, text: string, col: Column): void {
  // A JSON column (or any JSON-shaped value) renders as a colored,
  // collapsible tree; everything else falls back to the plain <pre>.
  // Parsing and rendering share one try/catch, matching record-view.ts's
  // pattern — a malformed tree build degrades to plain text the same as
  // unparseable JSON, rather than throwing out of a click handler.
  let isJson = true;
  try {
    $("cell-json").replaceChildren(renderJsonTree(JSON.parse(text) as JsonValue));
  } catch (err) {
    isJson = false;
    warnBadJsonCell(col, err);
  }
  $("cell-pre").hidden = isJson;
  $("cell-json").hidden = !isJson;
  if (!isJson) $("cell-pre").textContent = text;
  if (cellPopAnchor) cellPopAnchor.style.anchorName = "";
  cellPopAnchor = e.currentTarget as HTMLElement;
  cellPopAnchor.style.anchorName = "--cell-anchor";
  $("cell-pop").showPopover();
}

// A real <button> as the click target so it's keyboard-focusable and
// Enter/Space-activatable, matching the copy button one element over.
function buildCell(col: Column, row: Row, hidden: Set<string>): HTMLTableCellElement {
  const raw = row[col.name];
  const isNull = raw == null;
  // A null cell has no copy/expand affordance to clone, so it builds a bare
  // <td> rather than the template's.
  const td = isNull
    ? document.createElement("td")
    : ((cellTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableCellElement);
  td.dataset.col = col.name;
  if (hidden.has(col.name)) td.classList.add("col-hidden");
  if (isNull) {
    const span = el("span", "cell-text", "∅");
    td.appendChild(span);
    // Nothing to copy or expand for a null cell, but "filter by this
    // value" is still meaningful (IS NULL).
    const filterBtn = el("button", "filter-eq");
    filterBtn.setAttribute("aria-label", "filter by null");
    filterBtn.textContent = "=";
    filterBtn.onclick = (e) => {
      e.stopPropagation();
      applyFilterClause(columnKey(col), "IS NULL");
    };
    const actions = el("span", "cell-actions");
    actions.appendChild(filterBtn);
    td.appendChild(actions);
    return td;
  }
  const cellText = qs<HTMLElement>(td, ".cell-text");
  const btn = qs<HTMLElement>(td, ".copy");
  const filterBtn = qs<HTMLElement>(td, ".filter-eq");
  cellText.appendChild(formatCellValue(col, raw));
  btn.onclick = (e) => {
    e.stopPropagation();
    copyText(raw, btn);
  };
  filterBtn.onclick = (e) => {
    e.stopPropagation();
    applyFilterClause(columnKey(col), "=", raw);
  };
  if (col.references) {
    const references = col.references;
    cellText.classList.add("fk-cell");
    const refLabel = references.schema ? `${references.schema}.${references.table}` : references.table;
    cellText.title = `go to ${refLabel}.${references.column} = ${raw}`;
    cellText.onclick = () =>
      navigateWithSeededFilter(references.table, references.schema, () =>
        applyFilterClause(references.column, "=", raw),
      );
  } else if (col.key === "pk" && tableInView() !== null) {
    // Reverse of the FK-cell click: what points *at* this row. A pk+fk
    // column took the branch above; those rows, and no-PK tables, reach the
    // same list through the record dialog instead.
    cellText.classList.add("pk-cell");
    // Embeds `raw` so a truncated PK stays readable via hover, same as the
    // fk-cell title above — the overflow-expand skip below relies on it.
    cellText.title = `${raw} — what references this row`;
    cellText.onclick = (e) => openReferencedByPopover(e, row);
  } else {
    const jsonAtRender = rendersAsJson(col, raw);
    // scrollWidth > clientWidth is only known after layout, so decide
    // per click rather than per render.
    cellText.onclick = (e) => {
      if (jsonAtRender || cellText.scrollWidth > cellText.clientWidth) {
        showCellPop(e, raw, col);
      }
    };
    if (jsonAtRender) td.classList.add("expandable");
  }
  return td;
}

// ---- column show/hide: toggles a CSS class on already-rendered
// header/data cells, never a refetch. Matched by column name (data-col),
// not position, so it can't fall out of sync with header/cell alignment.
// A stale column name simply matches nothing — silent no-op. ----
function setColumnVisibility(name: string, hidden: boolean): void {
  const current = hiddenColumns();
  const next = hidden ? [...current, name] : current.filter((c) => c !== name);
  setHiddenColumns(next);
  for (const el of document.querySelectorAll(`[data-col="${CSS.escape(name)}"]`)) {
    el.classList.toggle("col-hidden", hidden);
  }
  refreshBands();
  updateColumnsButtonLabel();
}

export function updateColumnsButtonLabel(): void {
  const n = hiddenColumns().length;
  $("columns-btn").textContent = n > 0 ? `columns (${n} hidden)` : "columns";
}

export function renderColumnMenu(columns: Column[]): void {
  const hidden = hiddenColumns();
  $("columns-pop-list").replaceChildren(
    ...columns.map((col) => {
      const label = el("label");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !hidden.includes(col.name);
      input.onchange = () => setColumnVisibility(col.name, !input.checked);
      label.append(input, col.name);
      return label;
    }),
  );
}

function buildRowActionCell(columns: Column[], row: Row): HTMLTableCellElement {
  const td = (rowActionTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableCellElement;
  qs<HTMLElement>(td, ".record-btn").onclick = () => openRecordView(columns, row);
  return td;
}

// newRowKeys (rowKey values absent from the previous same-scope fetch,
// passed only on an explicit refresh) tint those rows via .row-new;
// pkNames is the matching PK column list, computed once by the caller.
export function renderRows(data: ViewData, newRowKeys?: Set<string>, pkNames: string[] = []): void {
  // Same for every cell in this render, so computed once rather than
  // re-derived (array rebuild + linear scan) per cell.
  const hidden = new Set(hiddenColumns());
  if (data.rows.length === 0) {
    // colSpan must match the *visible* column count, not the fetched one —
    // hidden columns (display:none) aren't counted.
    const visible = data.columns.filter((c) => !hidden.has(c.name)).length;
    renderEmptyState(visible + 1);
    return;
  }
  const tbody = $("tbody");
  tbody.replaceChildren(
    ...data.rows.map((row) => {
      const tr = el("tr");
      if (newRowKeys?.has(rowKey(pkNames, row))) tr.classList.add("row-new");
      tr.appendChild(buildRowActionCell(data.columns, row));
      for (const col of data.columns) {
        tr.appendChild(buildCell(col, row, hidden));
      }
      return tr;
    }),
  );
  // Overflow is only measurable after layout (JSON cells are marked at
  // render instead). fk-cell/pk-cell are excluded: their title is already
  // the escape hatch, and a click navigates rather than expands.
  requestAnimationFrame(() => {
    for (const el of tbody.querySelectorAll<HTMLElement>(".cell-text:not(.fk-cell):not(.pk-cell)")) {
      if (el.scrollWidth > el.clientWidth) el.closest("td")?.classList.add("expandable");
    }
  });
}

export function updatePager(data: ViewData): void {
  const page = Math.floor(state.offset / state.limit) + 1;
  $<HTMLButtonElement>("prev").disabled = state.offset === 0;
  if (joinInView()) {
    // A join has no total (spec/protocol.md §5.11.4): the page says whether more follows.
    $("page").textContent = `page ${page} · ${data.has_more ? "more rows available" : "last page"}`;
    $("row-meta").textContent =
      ` · ${data.rows.length}${data.has_more ? "+" : ""} rows · ${data.columns.length} columns`;
    $("row-meta").removeAttribute("title");
    $<HTMLButtonElement>("next").disabled = !data.has_more;
    return;
  }
  $("page").textContent = `page ${page}`;
  $("row-meta").textContent = ` · ${formatApproxCount(data.total_approx ?? -1)} rows · ${data.columns.length} columns`;
  $("row-meta").title = APPROX_COUNT_TITLE;
  $<HTMLButtonElement>("next").disabled = data.rows.length < state.limit;
}
