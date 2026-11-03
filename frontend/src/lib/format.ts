import type { Column, JoinClass } from "../core/types.js";

// Mirrors json-tree.ts's UUID scalar test; kept local so this leaf stays
// unit-testable without a runtime import.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Value-rendering helpers shared across feature modules. A leaf (type-only
// imports) so grid.ts / table-chips.ts / record-view.ts can share them without
// importing each other.

export function formatClock(at: Date): string {
  return at.toLocaleTimeString([], { hourCycle: "h23" });
}

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

// col.type is the DB engine's full spelling (Postgres format_type, MySQL
// COLUMN_TYPE, SQLite declared type or "unknown"), so bucketing folds case,
// drops length/precision groups and MySQL's unsigned/zerofill, and matches a
// closed alias set.
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

// Only the parenthesised groups go, so `numeric(10,2)[]` stays an array and
// `timestamp(3) with time zone` keeps its zone.
function typeKey(rawType: string): string {
  return rawType
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(unsigned|signed|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function columnTypeClass(rawType: string): ColumnTypeClass | null {
  // MySQL's boolean is tinyint(1); only the display width tells it apart.
  if (/^\s*tinyint\(1\)(\s|$)/i.test(rawType)) return "bool";
  return TYPE_ALIASES[typeKey(rawType)] ?? null;
}

const FROM_JOIN_CLASS: Partial<Record<JoinClass, ColumnTypeClass>> = {
  number: "number",
  temporal: "date",
  uuid: "uuid",
  boolean: "bool",
};

// The type name first; the server's join class covers what the name hides,
// such as a Postgres domain over integer, whose `type` is the domain's name.
export function cellTypeClass(col: Pick<Column, "type" | "class">): ColumnTypeClass | null {
  return columnTypeClass(col.type) ?? (col.class ? (FROM_JOIN_CLASS[col.class] ?? null) : null);
}

const TYPE_CLASS_CSS: Partial<Record<ColumnTypeClass, string>> = {
  number: "cell-type-number",
  bool: "cell-type-bool",
  uuid: "cell-type-uuid",
};

// Plain string types, where JSON is often stored as text (always, on
// SQLite). Value-shape detection is limited to these: Postgres arrays,
// ranges, multiranges and paths also lead with { or [ but are not JSON.
// SQLite's text-affinity rule (a name containing CHAR, CLOB or TEXT) covers
// every engine's spelling, plus SQLite's undeclared "" and our "unknown";
// `text[]` and `_text` are Postgres arrays.
function isTextType(type: string): boolean {
  if (type.endsWith("[]") || type.startsWith("_")) return false;
  return type === "" || type === "unknown" || /char|clob|text/.test(type);
}

// A column renders as a JSON tree when the backend typed it as JSON, or when
// it is a plain string type and the value itself leads with { or [.
export function rendersAsJson(col: Column, raw: string): boolean {
  const type = typeKey(col.type);
  if (TYPE_ALIASES[type] === "json") return true;
  // The class covers a text type whose name hides it, such as a domain over varchar.
  return (isTextType(type) || col.class === "text") && /^\s*[[{]/.test(raw);
}

// A value that won't parse is only worth flagging when the backend actually
// typed the column as JSON; a shape-detected guess that misses is expected.
export function warnBadJsonCell(col: Column, err: unknown): void {
  if (columnTypeClass(col.type) === "json") {
    console.warn(`ashurbanipal: JSON column ${col.name} is not valid JSON`, err);
  }
}

// JS `\s` (which takes in no-break space and the byte-order mark) plus the
// zero-width space: all of them make a value fail to match its visible text.
const isEdgeSpace = (ch: string) => /\s/.test(ch) || ch === "\u200B";

// A value's leading and trailing whitespace, apart from the rest. A value
// that is all whitespace is all `lead`. A scan, not a regex: an unanchored
// trailing-run regex backtracks quadratically on long inner runs.
export function edgeWhitespace(raw: string): { lead: string; core: string; trail: string } {
  let start = 0;
  while (start < raw.length && isEdgeSpace(raw[start])) start++;
  let end = raw.length;
  while (end > start && isEdgeSpace(raw[end - 1])) end--;
  return { lead: raw.slice(0, start), core: raw.slice(start, end), trail: raw.slice(end) };
}

const WS_NAMES: Record<string, [string, string]> = {
  " ": ["space", "spaces"],
  "\t": ["tab", "tabs"],
  "\u00A0": ["no-break space", "no-break spaces"],
  "\u200B": ["zero-width space", "zero-width spaces"],
  "\uFEFF": ["byte-order mark", "byte-order marks"],
};

const NEWLINE = /\r\n?|[\n\u2028\u2029]/g;

// The hover text for one edge run: "2 leading spaces", "trailing newline".
export function whitespaceTitle(run: string, side: "leading" | "trailing"): string {
  const chars = [...run.replace(NEWLINE, "\n")];
  if (chars.every((c) => c === "\n")) {
    return chars.length === 1 ? `${side} newline` : `${chars.length} ${side} newlines`;
  }
  const names = WS_NAMES[chars[0]];
  if (names && chars.every((c) => c === chars[0])) {
    return `${chars.length} ${side} ${chars.length === 1 ? names[0] : names[1]}`;
  }
  return `${chars.length} ${side} whitespace characters`;
}

// Whitespace with width stays as real text on a shaded span, so a selection
// copies it. A newline or a zero-width character has no width, so CSS draws
// a mark in an empty span instead.
function edgeMarks(run: string, side: "leading" | "trailing"): Node[] {
  const title = whitespaceTitle(run, side);
  return (run.match(/\r\n?|[\n\u2028\u2029]|[\u200B\uFEFF]|[^\r\n\u2028\u2029\u200B\uFEFF]+/g) ?? []).map((part) => {
    const span = document.createElement("span");
    span.title = title;
    if (/^[\r\n\u2028\u2029]/.test(part)) span.className = "cell-ws cell-nl";
    else if (/^[\u200B\uFEFF]/.test(part)) span.className = "cell-ws cell-zw";
    else {
      span.className = "cell-ws";
      span.textContent = part;
    }
    return span;
  });
}

function typedValue(col: Column, raw: string): Node {
  const klass = cellTypeClass(col);
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

// Shared by grid's buildCell and record-view's buildRecordEntries so a
// column's rendering rule lives in one place. Empty text and edge whitespace
// are marked, so neither reads as nothing.
export function formatCellValue(col: Column, raw: string): Node {
  if (raw === "") {
    const empty = document.createElement("span");
    empty.className = "cell-empty";
    empty.title = "empty text";
    empty.textContent = "''";
    return empty;
  }
  const { lead, core, trail } = edgeWhitespace(raw);
  if (!lead && !trail) return typedValue(col, raw);
  const out = document.createDocumentFragment();
  if (lead) out.append(...edgeMarks(lead, "leading"));
  if (core) out.append(typedValue(col, core));
  if (trail) out.append(...edgeMarks(trail, "trailing"));
  return out;
}
