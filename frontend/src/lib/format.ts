import type { Column } from "../core/types.js";

// Mirrors json-tree.ts's UUID scalar test; kept local so this leaf stays
// unit-testable without a runtime import.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// col.type is the DB engine's own catalog spelling (Postgres data_type,
// MySQL DATA_TYPE, SQLite declared type or "unknown"), so bucketing folds
// case, strips a length/precision suffix, and matches a closed alias set.
// An explicit set, never substring matching: "int" as a substring also
// hits Postgres interval/point/inet/int4range/line/lseg, none of them
// numbers. `date` covers plain dates and timestamps alike — nothing
// renders them differently.
export type ColumnTypeClass = "number" | "bool" | "date" | "uuid" | "json";

const TYPE_ALIASES: Record<string, ColumnTypeClass> = {
  smallint: "number",
  integer: "number",
  int: "number",
  int2: "number",
  int4: "number",
  int8: "number",
  bigint: "number",
  mediumint: "number",
  tinyint: "number",
  numeric: "number",
  decimal: "number",
  real: "number",
  double: "number",
  "double precision": "number",
  float: "number",
  number: "number",
  serial: "number",
  smallserial: "number",
  bigserial: "number",
  boolean: "bool",
  bool: "bool",
  date: "date",
  timestamp: "date",
  timestamptz: "date",
  datetime: "date",
  "timestamp with time zone": "date",
  "timestamp without time zone": "date",
  uuid: "uuid",
  json: "json",
  jsonb: "json",
};

export function columnTypeClass(rawType: string): ColumnTypeClass | null {
  const key = rawType
    .toLowerCase()
    .replace(/\s*\(.*$/, "")
    .trim();
  return TYPE_ALIASES[key] ?? null;
}

const TYPE_CLASS_CSS: Partial<Record<ColumnTypeClass, string>> = {
  number: "cell-type-number",
  bool: "cell-type-bool",
  uuid: "cell-type-uuid",
};

// A column renders as a JSON tree when the backend typed it as JSON, or —
// when the declared type isn't one we bucket (SQLite "unknown", Postgres
// "text"/"xml", …) — when the value itself leads with { or [.
export function rendersAsJson(col: Column, raw: string): boolean {
  const klass = columnTypeClass(col.type);
  return klass === "json" || (klass === null && /^\s*[[{]/.test(raw));
}

// A value that won't parse is only worth flagging when the backend actually
// typed the column as JSON; a shape-detected guess that misses is expected.
export function warnBadJsonCell(col: Column, err: unknown): void {
  if (columnTypeClass(col.type) === "json") {
    console.warn(`ashurbanipal: JSON column ${col.name} is not valid JSON`, err);
  }
}

// Shared by grid's buildCell and record-view's buildRecordEntries so a
// column's rendering rule lives in one place.
export function formatCellValue(col: Column, raw: string): Node {
  const klass = columnTypeClass(col.type);
  if (klass === "date") {
    // No `datetime` attribute: the engine's text cast isn't a valid HTML
    // datetime value on any backend.
    const time = document.createElement("time");
    time.textContent = raw;
    time.className = "cell-type-date";
    return time;
  }
  // An unbucketed type (SQLite "unknown"/"TEXT", Postgres "text", …) with a
  // UUID-shaped value still gets the uuid colour — the pattern is specific
  // enough to trust, and json-tree.ts colours nested UUID strings the same way.
  let cls: string | undefined;
  if (klass) cls = TYPE_CLASS_CSS[klass];
  else if (UUID_RE.test(raw)) cls = "cell-type-uuid";
  if (cls) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = raw;
    return span;
  }
  return document.createTextNode(raw);
}
