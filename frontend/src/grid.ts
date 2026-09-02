import { $, copyText } from "./dom.js";
import { applyFilterClause, showCommonValues } from "./filter-ui.js";
import { renderJsonTree, type JsonValue } from "./json-tree.js";
import { loadData } from "./main.js";
import { openRecordView } from "./record-view.js";
import { APPROX_COUNT_TITLE, formatApproxCount, loadTables } from "./sidebar.js";
import { hiddenColumnsForTable, persist, rememberSchema, rememberSort, rowKey, state } from "./state.js";
import type { Column, Row, TableData } from "./types.js";

export function renderHeader(columns: Column[]): void {
  const hidden = hiddenColumnsForTable();
  const tr = document.createElement("tr");
  const actionsTh = document.createElement("th");
  actionsTh.className = "row-actions";
  tr.appendChild(actionsTh);
  for (const col of columns) {
    const th = document.createElement("th");
    th.dataset.col = col.name;
    if (hidden.includes(col.name)) th.classList.add("col-hidden");
    const label = `${col.name} (${col.type})`;
    if (col.key === "pk" || col.key === "fk") {
      // A column can be its own table's PK and an FK at once (1:1 detail
      // table shape) — key still reports "pk", but references is populated
      // too (spec/protocol.md §5.4.1), so the label surfaces both facts.
      const keyLabel = col.key === "pk"
        ? (col.references
          ? `primary key, also references ${col.references.table}.${col.references.column}`
          : "primary key")
        : `foreign key, references ${col.references!.table}.${col.references!.column}`;
      const icon = document.createElement("span");
      icon.className = "key-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.title = keyLabel;
      icon.textContent = col.key === "pk" ? "🔑" : "🔗";
      th.append(icon, label);
      // Layers onto the accessible name rather than replacing the key
      // description — the icon keeps its own `title` above.
      th.setAttribute("aria-label", col.comment ? `${label}, ${keyLabel}, ${col.comment}` : `${label}, ${keyLabel}`);
    } else {
      th.append(label);
    }
    if (col.comment) th.title = col.comment;
    th.setAttribute("aria-sort", col.name === state.sort
      ? (state.order === "desc" ? "descending" : "ascending")
      : "none");
    th.onclick = () => {
      state.order = state.sort === col.name && state.order === "asc" ? "desc" : "asc";
      state.sort = col.name; state.offset = 0; rememberSort(); loadData({ resetScroll: false });
    };
    // A focusable control nested in the sortable th — stopPropagation so
    // opening it doesn't also toggle sort.
    const cvBtn = document.createElement("button");
    cvBtn.type = "button";
    cvBtn.className = "common-values-btn";
    cvBtn.setAttribute("aria-label", `common values for ${col.name}`);
    cvBtn.textContent = "▾";
    cvBtn.onclick = (e) => { e.stopPropagation(); showCommonValues(e, col.name); };
    th.appendChild(cvBtn);
    tr.appendChild(th);
  }
  $("thead").replaceChildren(tr);
}

export function renderEmptyState(columnCount: number): void {
  const emptyRow = document.createElement("tr");
  emptyRow.className = "empty";
  const td = document.createElement("td");
  td.colSpan = columnCount;
  td.textContent = state.offset > 0 ? "No more rows." : "No rows match this view.";
  emptyRow.appendChild(td);
  $("tbody").replaceChildren(emptyRow);
}

const cellTemplate = $<HTMLTemplateElement>("cell-template");
const rowActionTemplate = $<HTMLTemplateElement>("row-action-template");

// Postgres data_type strings bucketed into the --type-* palette — ground
// truth from the schema, so unlike renderJsonTree's scalars this is a
// straight lookup, no parsing needed.
const CELL_TYPE_CLASSES: Record<string, string> = {
  boolean: "cell-type-bool",
  uuid: "cell-type-uuid",
  smallint: "cell-type-number",
  integer: "cell-type-number",
  bigint: "cell-type-number",
  numeric: "cell-type-number",
  real: "cell-type-number",
  "double precision": "cell-type-number",
};

// Shared by buildCell and buildRecordEntries so a column's rendering rule
// lives in one place.
export function formatCellValue(col: Column, raw: string): Node {
  if (col.type === "timestamp with time zone" || col.type === "date") {
    const time = document.createElement("time");
    time.dateTime = raw;
    time.textContent = raw;
    time.className = "cell-type-date";
    return time;
  }
  const cls = CELL_TYPE_CLASSES[col.type];
  if (cls) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = raw;
    return span;
  }
  return document.createTextNode(raw);
}

// ---- cell preview ----
let cellPopAnchor: HTMLElement | null = null;
function showCellPop(e: MouseEvent, text: string): void {
  // jsonb (or any JSON-shaped value) renders as a colored, collapsible
  // tree; everything else falls back to the plain <pre>. Parsing and
  // rendering share one try/catch, matching record-view.ts's pattern —
  // a malformed tree build degrades to plain text the same as
  // unparseable JSON, rather than throwing out of a click handler.
  let isJson = true;
  try {
    $("cell-json").replaceChildren(renderJsonTree(JSON.parse(text) as JsonValue));
  } catch {
    isJson = false;
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
export function buildCell(col: Column, raw: string | null): HTMLTableCellElement {
  const hidden = hiddenColumnsForTable().includes(col.name);
  if (raw == null) {
    const td = document.createElement("td");
    td.dataset.col = col.name;
    if (hidden) td.classList.add("col-hidden");
    const span = document.createElement("span");
    span.className = "cell-text";
    span.textContent = "∅";
    td.appendChild(span);
    // Nothing to copy or expand for a null cell, but "filter by this
    // value" is still meaningful (IS NULL).
    const filterBtn = document.createElement("button");
    filterBtn.className = "filter-eq only-action";
    filterBtn.setAttribute("aria-label", "filter by null");
    filterBtn.textContent = "=";
    filterBtn.onclick = (e) => { e.stopPropagation(); applyFilterClause(col.name, "IS NULL"); };
    td.appendChild(filterBtn);
    return td;
  }
  const td = (cellTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableCellElement;
  td.dataset.col = col.name;
  if (hidden) td.classList.add("col-hidden");
  const cellText = td.querySelector<HTMLElement>(".cell-text")!;
  const btn = td.querySelector<HTMLElement>(".copy")!;
  const filterBtn = td.querySelector<HTMLElement>(".filter-eq")!;
  cellText.appendChild(formatCellValue(col, raw));
  btn.onclick = (e) => { e.stopPropagation(); copyText(raw, btn); };
  filterBtn.onclick = (e) => { e.stopPropagation(); applyFilterClause(col.name, "=", raw); };
  if (col.references) {
    // In-app navigation: switch to the referenced table and seed a filter
    // for the referenced row. Clear sort rather than restore the target's
    // remembered one — this path submits a filter in the same fetch, which
    // would defeat loadData's drop-and-retry if that stored column is stale.
    cellText.classList.add("fk-cell");
    const refLabel = col.references.schema
      ? `${col.references.schema}.${col.references.table}`
      : col.references.table;
    cellText.title = `go to ${refLabel}.${col.references.column} = ${raw}`;
    cellText.onclick = () => {
      const references = col.references!;
      state.table = references.table;
      state.sort = null;
      // `references.schema` is only present when it differs from the
      // current schema (a cross-schema FK) — switch the selector too,
      // mirroring #schema-select's onchange, before navigating so the
      // table lookup below lands in the right schema rather than a
      // same-named table in the wrong one. loadTables() auto-loads a
      // default view as a side effect (same as #schema-select's onchange
      // triggers); applyFilterClause's own load immediately supersedes it
      // via loadDataToken, so the extra fetch is discarded, not shown.
      if (references.schema && references.schema !== state.schema) {
        state.schema = references.schema;
        $<HTMLSelectElement>("schema-select").value = state.schema;
        rememberSchema();
        loadTables()
          .then(() => applyFilterClause(references.column, "=", raw))
          .catch((e) => { $("error").textContent = e.message; });
        return;
      }
      persist();
      applyFilterClause(references.column, "=", raw);
    };
  } else {
    // scrollWidth > clientWidth is only known after layout, so decide
    // per click rather than per render.
    cellText.onclick = (e) => {
      if (col.type === "jsonb" || cellText.scrollWidth > cellText.clientWidth) {
        showCellPop(e, raw);
      }
    };
    if (col.type === "jsonb") td.classList.add("expandable");
  }
  return td;
}

// ---- column show/hide: toggles a CSS class on already-rendered
// header/data cells, never a refetch. Matched by column name (data-col),
// not position, so it can't fall out of sync with header/cell alignment.
// A stale column name simply matches nothing — silent no-op. ----
function setColumnVisibility(name: string, hidden: boolean): void {
  const current = hiddenColumnsForTable();
  const next = hidden ? [...current, name] : current.filter((c) => c !== name);
  const table = state.table ?? "";
  if (next.length) state.hiddenColumns[table] = next;
  else delete state.hiddenColumns[table];
  persist();
  document.querySelectorAll(`[data-col="${CSS.escape(name)}"]`)
    .forEach((el) => el.classList.toggle("col-hidden", hidden));
  updateColumnsButtonLabel();
}

export function updateColumnsButtonLabel(): void {
  const n = hiddenColumnsForTable().length;
  $("columns-btn").textContent = n > 0 ? `columns (${n} hidden)` : "columns";
}

export function renderColumnMenu(columns: Column[]): void {
  const hidden = hiddenColumnsForTable();
  $("columns-pop-list").replaceChildren(...columns.map((col) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !hidden.includes(col.name);
    input.onchange = () => setColumnVisibility(col.name, !input.checked);
    label.append(input, col.name);
    return label;
  }));
}

function buildRowActionCell(columns: Column[], row: Row): HTMLTableCellElement {
  const td = (rowActionTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableCellElement;
  td.querySelector<HTMLElement>(".record-btn")!.onclick = () => openRecordView(columns, row);
  return td;
}

// newRowKeys (rowKey values absent from the previous same-scope fetch,
// passed only on an explicit refresh) tint those rows via .row-new;
// pkNames is the matching PK column list, computed once by the caller.
export function renderRows(data: TableData, newRowKeys?: Set<string>, pkNames: string[] = []): void {
  if (data.rows.length === 0) {
    // colSpan must match the *visible* column count, not the fetched one —
    // hidden columns (display:none) aren't counted.
    const hidden = hiddenColumnsForTable();
    const visible = data.columns.filter((c) => !hidden.includes(c.name)).length;
    renderEmptyState(visible + 1);
    return;
  }
  const tbody = $("tbody");
  tbody.replaceChildren(...data.rows.map((row) => {
    const tr = document.createElement("tr");
    if (newRowKeys?.has(rowKey(pkNames, row))) tr.classList.add("row-new");
    tr.appendChild(buildRowActionCell(data.columns, row));
    for (const col of data.columns) {
      tr.appendChild(buildCell(col, row[col.name]));
    }
    return tr;
  }));
  // Overflow is only measurable after layout (jsonb cells are marked at
  // render instead). fk-cell is excluded: its title is already the escape
  // hatch, and a click navigates rather than expands.
  requestAnimationFrame(() => {
    for (const el of tbody.querySelectorAll<HTMLElement>(".cell-text:not(.fk-cell)")) {
      if (el.scrollWidth > el.clientWidth) el.closest("td")?.classList.add("expandable");
    }
  });
}

export function updatePager(data: TableData): void {
  const page = Math.floor(state.offset / state.limit) + 1;
  $("page").textContent = `page ${page} · ${formatApproxCount(data.total_approx)} rows`;
  $("page").title = APPROX_COUNT_TITLE;
  $<HTMLButtonElement>("prev").disabled = state.offset === 0;
  $<HTMLButtonElement>("next").disabled = data.rows.length < state.limit;
}
