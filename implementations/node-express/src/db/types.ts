import type { Condition } from "../filter.js";

export type KeyKind = "pk" | "fk";

export interface ColumnRef {
  table: string;
  column: string;
  // Only set when the referenced table lives in a schema other than the
  // referencing column's own — same-schema FKs (the common case) omit it,
  // so the wire payload is unchanged from before this field existed
  // (additive, spec/protocol.md §7 versioning policy).
  schema?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  key?: KeyKind;
  references?: ColumnRef;
  comment?: string;
}

export interface TableInfo {
  name: string;
  comment?: string;
}

export interface TableData {
  columns: ColumnInfo[];
  rows: Record<string, string | null>[];
  total_approx: number;
}

export interface CountEntry {
  table: string;
  approx_rows: number;
}

export interface CommonValueEntry {
  value: string;
  freq: number;
}

export interface QueryOpts {
  limit: number;
  offset: number;
  sort?: string;
  descending: boolean;
  filter: Condition[];
}

/**
 * The one seam to the database — route handlers never touch a driver
 * directly (mirrors implementations/rust/src/db/mod.rs's `DbSource`
 * trait). One implementation per backend: `PostgresSource` (default),
 * `SqliteSource`, `MySqlSource` — the host explicitly constructs and
 * wires whichever it wants into createRouter, so backend selection is
 * always explicit code, never driver auto-detection.
 *
 * `timeoutMs` is threaded per-call rather than baked into the instance:
 * every call, catalog/metadata queries included, must be bounded
 * (spec/protocol.md §6), and Node's Catalog historically applied one
 * configured value uniformly to everything (unlike the Rust reference's
 * separate hardcoded CATALOG_TIMEOUT_SECS) — threading it per-call keeps
 * that behavior while letting one DbSource instance serve requests
 * carrying different configured timeouts without mutable instance state.
 */
export interface DbSource {
  listSchemas(timeoutMs: number): Promise<string[]>;
  listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]>;
  tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]>;
  queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData>;
  commonValues(
    schema: string | undefined,
    table: string,
    column: string,
    timeoutMs: number,
  ): Promise<CommonValueEntry[]>;
}

export function findExact(haystack: string[], needle: string): string | undefined {
  return haystack.find((s) => s === needle);
}

// Every SELECTed column is already cast to a text representation in the
// query text itself (never decoded into a native JS type and reformatted
// — spec/protocol.md §5.4.3's cast-in-SQL requirement), so a conformant
// driver always hands back a string or null for these columns. Anything
// else (a driver decode this port doesn't expect) falls back to the
// sentinel rather than throwing and aborting the whole row.
export function cellToJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "<undecodable>";
}

// The hardcoded operator -> SQL-keyword table (spec/protocol.md §5.4.2),
// shared across backends — wire text never becomes an operator except
// through this match. The *fragment* built around the keyword (cast
// syntax, placeholder style, ILIKE special-casing) is backend-specific;
// see each db/*.ts's own buildWhereClause.
export function opSql(op: string): string {
  switch (op) {
    case "=":
      return "=";
    case "!=":
      return "!=";
    case ">":
      return ">";
    case "<":
      return "<";
    case ">=":
      return ">=";
    case "<=":
      return "<=";
    case "LIKE":
      return "LIKE";
    case "ILIKE":
      return "ILIKE";
    case "IS NULL":
      return "IS NULL";
    case "IS NOT NULL":
      return "IS NOT NULL";
    default:
      throw new Error(`opSql called with an op the caller should have validated: ${op}`);
  }
}

export function opTakesValue(op: string): boolean {
  return op !== "IS NULL" && op !== "IS NOT NULL";
}
