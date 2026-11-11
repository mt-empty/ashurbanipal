import { loadData } from "../bootstrap/reload.js";
import { tableEl } from "../bootstrap/table-focus.js";
import { $, copyText, el, qs } from "../core/dom.js";
import {
  hiddenColumns,
  joinInView,
  noCountsFor,
  setHiddenColumns,
  setSort,
  state,
  tableInView,
} from "../core/state.js";
import type { Column, Row, View, ViewData } from "../core/types.js";
import type { KeyDescription } from "../lib/column-key.js";
import { eqClause, filterClause } from "../lib/filter-dsl.js";
import {
  APPROX_COUNT_TITLE,
  formatApproxCount,
  formatCellValue,
  rendersAsJson,
  warnBadJsonCell,
} from "../lib/format.js";
import { type JsonValue, renderJsonTree } from "../lib/json-tree.js";
import { rowKey } from "../lib/row-diff.js";
import { eqButton, fkLink, keyIcon, typeChip } from "./column-parts.js";
import { columnMinWidth } from "./column-widths.js";
import { applyFilter, commonValueSource, commonValuesButton } from "./filter-ui.js";
import { markGridDrawn } from "./grid-lock.js";
import { switchToLeftJoin } from "./join-dialog.js";
import { buildBands, buildEmptyJoin, columnKey, displayName, refreshBands, tableGroups } from "./join-view.js";
import { openRecordView } from "./record-view.js";
import { openReferencedByPopover } from "./referenced-by.js";
import { keyDescriptionOf, type TableMeta, tableMeta } from "./table-meta.js";
import { navigateWithSeededFilter } from "./view-history.js";

// The columns and view the grid last rendered; the columns menu, the counts,
// the sort note and the record dialog all describe these. state.view moves to
// a newly chosen view before its data arrives, and a failed load never brings
// that view to the grid.
let columnsInView: Column[] = [];
let viewInGrid: View | null = null;

interface ColumnCounts {
  hidden: Set<string>;
  shown: number;
  total: number;
}

let counts: ColumnCounts = { hidden: new Set(), shown: 0, total: 0 };

function countColumns(): void {
  const hidden = new Set(hiddenColumns());
  counts = { hidden, shown: columnsInView.filter((c) => !hidden.has(c.name)).length, total: columnsInView.length };
}

export function renderHeader(columns: Column[]): void {
  columnsInView = columns;
  viewInGrid = state.view;
  markGridDrawn();
  countColumns();
  const { hidden } = counts;
  const meta = tableMeta(tableInView());
  // Every member of a composite primary key reports key "pk".
  const singlePk = columns.filter((c) => c.key === "pk").length === 1;
  const tr = el("tr");
  const actionsTh = el("th", "row-actions");
  tr.appendChild(actionsTh);
  for (const col of columns) {
    const th = el("th");
    th.dataset.col = col.name;
    if (col.join !== undefined) th.dataset.join = String(col.join);
    const minWidth = columnMinWidth(col.name);
    if (minWidth) th.style.minWidth = `${minWidth}px`;
    if (hidden.has(col.name)) th.classList.add("col-hidden");
    // Also the sort key: sort and filter name a column the same way.
    const fullName = columnKey(col);
    const label = `${fullName} (${col.type})`; // the aria-label's plain-text form
    // Name, ▾ and the sort arrow share one line; the type chip sits under it.
    const head = el("span", "th-name");
    // Capped in CSS (a 63-char identifier would otherwise set the column's
    // width); the title is the escape hatch (R8). A button so the sort is
    // reachable by keyboard: its click bubbles to th.onclick.
    const nameEl = el("button", "col-name sort-btn", displayName(col));
    nameEl.type = "button";
    nameEl.title = col.comment ? `${fullName} — ${col.comment}` : fullName;
    const key = keyDescriptionOf(col, meta);
    if (key) {
      head.append(keyIcon(key), nameEl, " ");
      // Layers onto the accessible name rather than replacing the key
      // description — the icon keeps its own `title` above.
      th.setAttribute("aria-label", col.comment ? `${label}, ${key.label}, ${col.comment}` : `${label}, ${key.label}`);
    } else {
      head.append(nameEl, " ");
    }
    if (col.comment) th.title = col.comment;
    th.setAttribute(
      "aria-sort",
      fullName === state.sort ? (state.order === "desc" ? "descending" : "ascending") : "none",
    );
    th.onclick = () => {
      setSort(fullName, state.sort === fullName && state.order === "asc" ? "desc" : "asc");
      loadData({ resetScroll: false });
    };
    const source = commonValueSource(col);
    if (source) {
      // A column unique on its own has no common values to show. A join's pk count
      // spans its tables, so there a pk counts as alone until its table's facts arrive.
      const sourceMeta = tableMeta(source.table);
      const pkAlone = col.join === undefined ? singlePk : sourceMeta === undefined;
      const unique = (col.key === "pk" && pkAlone) || sourceMeta?.uniqueColumns.has(source.column);
      if (!unique) head.appendChild(commonValuesButton(source.table, source.column, columnKey(col)));
    }
    th.append(head, typeChip(col));
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
  // The same rule as the record view (rendersAsJson): a tree when it parses,
  // else the plain <pre>. Parse and render share one catch, so a malformed
  // tree build degrades to plain text instead of throwing out of a click handler.
  let isJson = rendersAsJson(col, text);
  if (isJson) {
    try {
      $("cell-json").replaceChildren(renderJsonTree(JSON.parse(text) as JsonValue));
    } catch (err) {
      isJson = false;
      warnBadJsonCell(col, err);
    }
  }
  $("cell-pre").hidden = isJson;
  $("cell-json").hidden = !isJson;
  if (!isJson) $("cell-pre").textContent = text;
  if (cellPopAnchor) cellPopAnchor.style.anchorName = "";
  cellPopAnchor = e.currentTarget as HTMLElement;
  cellPopAnchor.style.anchorName = "--cell-anchor";
  $("cell-pop").showPopover();
}

interface CellContext {
  hidden: Set<string>;
  meta: TableMeta | undefined;
}

// A real <button> as the click target so it's keyboard-focusable and
// Enter/Space-activatable, matching the copy button one element over.
function buildCell(col: Column, row: Row, { hidden, meta }: CellContext): HTMLTableCellElement {
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
    const span = el("span", "cell-text cell-null", "∅");
    span.title = "null";
    td.appendChild(span);
    // Nothing to copy or expand for a null cell, but "filter by this
    // value" is still meaningful (IS NULL).
    const clause = filterClause(columnKey(col), "IS NULL");
    const actions = el("span", "cell-actions");
    actions.appendChild(
      eqButton(true, (e) => {
        e.stopPropagation();
        applyFilter(clause);
      }),
    );
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
  const eq = eqClause(columnKey(col), raw);
  if (eq === null) filterBtn.remove();
  else {
    filterBtn.onclick = (e) => {
      e.stopPropagation();
      applyFilter(eq);
    };
  }
  const link = fkLink(col, raw, row, meta);
  if (link) {
    cellText.classList.add("fk-cell");
    cellText.title = link.title;
    cellText.onclick = () => navigateWithSeededFilter(link.target, link.clause);
  } else if (col.key === "pk" && meta !== undefined && meta.referrers !== 0) {
    // What points *at* this row, once the table is known to have referrers (or
    // the lookup failed); FK-bearing PKs and no-PK tables use the record dialog.
    cellText.classList.add("pk-cell");
    // Embeds `raw` so a truncated PK stays readable via hover, same as the
    // fk-cell title above — the overflow-expand skip below relies on it.
    const n = meta.referrers;
    cellText.title =
      n === null ? `${raw} — what references this row` : `${raw} — referenced by ${n} ${n === 1 ? "table" : "tables"}`;
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
// not position, so it can't fall out of sync with header/cell alignment. ----
function setHidden(next: readonly string[]): void {
  const before = new Set(hiddenColumns());
  const after = new Set(next);
  setHiddenColumns([...after]);
  // Only the names that changed: while another view loads, the stored set is
  // that view's, not the one the grid shows.
  for (const name of new Set([...before, ...after])) {
    if (before.has(name) === after.has(name)) continue;
    for (const cell of tableEl.querySelectorAll(`[data-col="${CSS.escape(name)}"]`)) {
      cell.classList.toggle("col-hidden", after.has(name));
    }
  }
  countColumns();
  refreshBands();
  syncColumnChrome();
  writeRowMeta();
}

function setColumnHidden(name: string, hide: boolean): void {
  const current = hiddenColumns();
  setHidden(hide ? [...current, name] : current.filter((c) => c !== name));
}

function sortedColumn(): Column | undefined {
  return state.sort === null ? undefined : columnsInView.find((c) => columnKey(c) === state.sort);
}

// The rows part of #row-meta, set by updatePager once a load has rendered.
let rowsMeta = "";

function setRowsMeta(text: string, title: string | null): void {
  rowsMeta = text;
  writeRowMeta();
  if (title === null) $("row-meta").removeAttribute("title");
  else $("row-meta").title = title;
}

function writeRowMeta(): void {
  const { shown, total } = counts;
  $("row-meta").textContent = `${rowsMeta} · ${shown < total ? `${shown} of ${total}` : total} columns`;
}

const sortArrow = (): string => (state.order === "desc" ? "↓" : "↑");

// With nothing in view the grid is left as it was, but nothing is sorted or hidden.
export function hideColumnNotes(): void {
  $("sort-note").hidden = true;
  $("all-hidden").hidden = true;
}

// Everything that describes which columns show, kept in step after a load
// and after every toggle.
function syncColumnChrome(): void {
  const { hidden, shown, total } = counts;
  $("columns-btn").textContent = shown < total ? `columns (${total - shown} hidden)` : "columns";

  const sorted = sortedColumn();
  for (const item of $("columns-pop-list").querySelectorAll<HTMLElement>("label[data-name]")) {
    const name = item.dataset.name as string;
    qs<HTMLInputElement>(item, "input").checked = !hidden.has(name);
    const tag = qs<HTMLElement>(item, ".cols-sorted");
    tag.hidden = sorted?.name !== name;
    tag.textContent = tag.hidden ? "" : `sorted ${sortArrow()}`;
  }
  for (const group of $("columns-pop-list").querySelectorAll<HTMLElement>(".cols-group")) {
    const names = [...group.querySelectorAll<HTMLElement>("label[data-name]")].map((l) => l.dataset.name as string);
    qs<HTMLElement>(group, ".cols-count").textContent =
      `${names.filter((n) => !hidden.has(n)).length} of ${names.length}`;
  }

  // Named even when its header is in view: on a wide table it is often scrolled out of sight.
  $("sort-note").hidden = sorted === undefined;
  if (sorted) {
    $("sort-note-col").textContent = columnKey(sorted);
    $("sort-note-col").title = columnKey(sorted);
    $("sort-note-dir").textContent = sortArrow();
    $("sort-note-show").hidden = !hidden.has(sorted.name);
  }

  $("all-hidden").hidden = total === 0 || shown > 0;
  $("all-hidden-text").textContent = `All ${total} columns are hidden.`;
  // Set when the rows rendered; a column shown since then must widen it.
  const emptyCell = $("tbody").querySelector<HTMLTableCellElement>("tr.empty > td");
  if (emptyCell) emptyCell.colSpan = shown + 1;
}

// Back to the database's own order; the table's remembered sort goes too (R11).
$("sort-note-clear").onclick = () => {
  setSort(null);
  loadData({ resetScroll: false });
};
$("sort-note-show").onclick = () => {
  const sorted = sortedColumn();
  if (sorted) setColumnHidden(sorted.name, false);
};
$("all-hidden-show").onclick = () => setHidden([]);

interface ColumnGroup {
  label: string;
  band: number;
  columns: Column[];
}

// A join's columns under the table each came from, in table order (one group
// per table even when the select list alternates); a table view is one group.
function columnGroups(columns: Column[]): ColumnGroup[] {
  if (viewInGrid?.kind !== "join") return [{ label: viewInGrid?.table ?? "", band: 0, columns }];
  return tableGroups(columns, viewInGrid.def).map((g) => ({ label: g.label, band: g.index, columns: g.columns }));
}

function groupButton(action: "all" | "none", label: string, names: ReadonlySet<string>): HTMLButtonElement {
  const btn = el("button", "cols-action", action);
  btn.type = "button";
  btn.setAttribute("aria-label", `${action === "all" ? "show" : "hide"} all ${label} columns`);
  btn.onclick = () => {
    const rest = hiddenColumns().filter((n) => !names.has(n));
    setHidden(action === "all" ? rest : [...rest, ...names]);
  };
  return btn;
}

function buildMenuItem(col: Column, key: KeyDescription | null): HTMLLabelElement {
  const label = el("label");
  label.dataset.name = col.name;
  const input = el("input");
  input.type = "checkbox";
  input.onchange = () => setColumnHidden(col.name, !input.checked);
  const fullName = columnKey(col);
  // In a join the visible name drops the table, which the heading carries.
  if (fullName !== displayName(col) || key)
    input.setAttribute("aria-label", key ? `${fullName}, ${key.label}` : fullName);
  const text = el("span", "cols-name", displayName(col));
  text.title = fullName;
  const type = el("span", "cols-type", col.type);
  type.title = col.type;
  // The key slot stays even when empty, so every row's name starts in one column.
  label.append(input, keyIcon(key), text, type, el("span", "cols-sorted"));
  return label;
}

function buildMenuGroup(group: ColumnGroup, keys: Map<string, KeyDescription | null>): HTMLElement {
  const box = el("div", "cols-group");
  box.dataset.band = String(group.band);
  const head = el("div", "cols-head");
  const pill = el("span", "cols-pill", group.label);
  pill.title = group.label;
  const names = new Set(group.columns.map((c) => c.name));
  head.append(
    pill,
    el("span", "cols-count"),
    groupButton("all", group.label, names),
    groupButton("none", group.label, names),
  );
  box.append(head, ...group.columns.map((c) => buildMenuItem(c, keys.get(c.name) ?? null)));
  return box;
}

// What the menu's controls were built for. A load that returns the same
// columns (an auto-refresh tick, a sort, a page) keeps them, so focus and
// hover in an open menu stay put; syncColumnChrome updates their state.
let menuShape = "";

export function renderColumnMenu(): void {
  const groups = columnGroups(columnsInView);
  const meta = tableMeta(tableInView());
  const keys = new Map(columnsInView.map((c) => [c.name, keyDescriptionOf(c, meta)]));
  const shape = JSON.stringify([
    groups.map((g) => [g.band, g.label, g.columns.map((c) => [c.name, columnKey(c), c.type])]),
    [...keys],
  ]);
  if (shape !== menuShape) {
    menuShape = shape;
    $("columns-pop-list").replaceChildren(...groups.map((g) => buildMenuGroup(g, keys)));
  }
  syncColumnChrome();
}

function buildRowActionCell(columns: Column[], rows: Row[], index: number): HTMLTableCellElement {
  const td = (rowActionTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableCellElement;
  const def = viewInGrid?.kind === "join" ? viewInGrid.def : undefined;
  qs<HTMLElement>(td, ".record-btn").onclick = () => openRecordView(columns, rows, index, def);
  return td;
}

// newRowKeys (rowKey values absent from the previous same-scope fetch,
// passed only on an explicit refresh) tint those rows via .row-new;
// pkNames is the matching PK column list, computed once by the caller.
export function renderRows(data: ViewData, newRowKeys?: Set<string>, pkNames: string[] = []): void {
  const { hidden, shown } = counts;
  if (data.rows.length === 0) {
    // colSpan must match the *visible* column count, not the fetched one —
    // hidden columns (display:none) aren't counted.
    renderEmptyState(shown + 1);
    return;
  }
  const ctx: CellContext = { hidden, meta: tableMeta(tableInView()) };
  const tbody = $("tbody");
  tbody.replaceChildren(
    ...data.rows.map((row, index) => {
      const tr = el("tr");
      if (newRowKeys?.has(rowKey(pkNames, row))) tr.classList.add("row-new");
      tr.appendChild(buildRowActionCell(data.columns, data.rows, index));
      for (const col of data.columns) {
        tr.appendChild(buildCell(col, row, ctx));
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
    setRowsMeta(` · ${data.rows.length}${data.has_more ? "+" : ""} rows`, null);
    $<HTMLButtonElement>("next").disabled = !data.has_more;
    return;
  }
  $("page").textContent = `page ${page}`;
  if (noCountsFor(state.scope.source)) setRowsMeta("", null);
  else setRowsMeta(` · ${formatApproxCount(data.total_approx ?? -1)} rows`, APPROX_COUNT_TITLE);
  $<HTMLButtonElement>("next").disabled = data.rows.length < state.limit;
}
