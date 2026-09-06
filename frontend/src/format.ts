import type { Column } from "./types.js";

// Value-rendering helpers shared across feature modules. A leaf (type-only
// imports) so grid.ts / sidebar.ts / record-view.ts can share them without
// importing each other.

// approx_rows/total_approx is -1 when the backend has no cheap estimate for
// this table (e.g. Postgres before ANALYZE, or an engine with no such
// catalog at all — see docs/adapter-decisions.md); show "?" rather than a
// confusing raw negative number. No leading "~" in that case either —
// "~?" would read as "approximately unknown".
export function formatApproxCount(n: number | null | undefined): string {
  return n == null || n < 0 ? "?" : `~${n}`;
}
export const APPROX_COUNT_TITLE =
  "~ = approximate, from the backend's own statistics, not a live count; " +
  "? = no cheap estimate available (table not yet analyzed, or this backend keeps no such statistics)";

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

// Shared by grid's buildCell and record-view's buildRecordEntries so a
// column's rendering rule lives in one place.
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
