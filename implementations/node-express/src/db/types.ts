import type { Condition } from "../filter.js";
import type { JoinData, JoinOpts, JoinSpec } from "../join.js";

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

/** One `{from, to}` pairing of an incoming FK (`spec/protocol.md` §5.9): `from` is the referencing column, `to` the referenced column; a composite FK has more than one. */
export interface ColumnPair {
  from: string;
  to: string;
}

/** One FK constraint elsewhere in the source whose target is the requested table (`spec/protocol.md` §5.9 — the reverse of {@link ColumnRef}). */
export interface ReferencedByEntry {
  table: string;
  // Set only when the referencing table's schema differs from the resolved
  // one — the opposite end of the relationship from ColumnRef.schema.
  schema?: string;
  constraint: string;
  columns: ColumnPair[];
}

/** One index of a table (`spec/protocol.md` §5.10); `columns` are the key columns in index order, an expression entry being its expression text. */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  /** Partial-index `WHERE` text; omitted for a non-partial index. */
  predicate?: string;
}

/** An outgoing foreign key, single-column or composite. `table`/`schema` name the referenced table; `schema` is set only when it differs from the resolved one. */
export interface ConstraintFk {
  name: string;
  table: string;
  schema?: string;
  columns: ColumnPair[];
  on_delete: string;
  on_update: string;
}

export interface Constraints {
  primary_key?: { name?: string; columns: string[] };
  unique: { name: string; columns: string[] }[];
  foreign_keys: ConstraintFk[];
  check: { name: string; expression?: string }[];
}

/** Response body of `GET /api/tables/structure` (`spec/protocol.md` §5.10). */
export interface Structure {
  indexes: IndexInfo[];
  constraints: Constraints;
}

export function emptyStructure(): Structure {
  return { indexes: [], constraints: { unique: [], foreign_keys: [], check: [] } };
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

/** Database seam; every call is timeout-bounded (`spec/protocol.md` §1, §6). */
export interface DbSource {
  listSchemas(timeoutMs: number): Promise<SchemaListing>;
  listTables(schema: string | undefined, timeoutMs: number): Promise<TableInfo[]>;
  tableCounts(schema: string | undefined, timeoutMs: number): Promise<CountEntry[]>;
  queryTable(schema: string | undefined, table: string, opts: QueryOpts, timeoutMs: number): Promise<TableData>;
  commonValues(
    schema: string | undefined,
    table: string,
    column: string,
    timeoutMs: number,
  ): Promise<CommonValueEntry[]>;
  /** Incoming FK references: every FK constraint elsewhere in the source whose target is `table` (`spec/protocol.md` §5.9). */
  referencedBy(schema: string | undefined, table: string, timeoutMs: number): Promise<ReferencedByEntry[]>;
  /** Indexes and constraints of `table` (`spec/protocol.md` §5.10). */
  structure(schema: string | undefined, table: string, timeoutMs: number): Promise<Structure>;
  /** Rows from the tables a join names (`spec/protocol.md` §5.11). */
  queryJoin(schema: string | undefined, spec: JoinSpec, opts: JoinOpts, timeoutMs: number): Promise<JoinData>;
}

export function findExact(haystack: string[], needle: string): string | undefined {
  return haystack.find((s) => s === needle);
}

/**
 * A source's browsable schemas plus the one an absent `schema` param resolves
 * to: null when the connection has no default schema, or its default is not
 * listed (`spec/protocol.md` §5.7).
 */
export interface SchemaListing {
  schemas: string[];
  default: string | null;
}

export function schemaListing(schemas: string[], defaultSchema: string | null): SchemaListing {
  const listed = defaultSchema === null ? undefined : findExact(schemas, defaultSchema);
  return { schemas, default: listed ?? null };
}

// Merges single-pair ReferencedByEntry rows into one entry per
// (schema, table, constraint). Relies on the caller's catalog ORDER BY
// putting a constraint's columns adjacent — a run-length merge, not a full
// group-by. Each backend maps its own row shape (and applies any
// allow-list filter) before calling this.
export function groupReferencedBy(rows: ReferencedByEntry[]): ReferencedByEntry[] {
  const out: ReferencedByEntry[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.table === row.table && last.schema === row.schema && last.constraint === row.constraint) {
      last.columns.push(...row.columns);
    } else {
      out.push(row);
    }
  }
  return out;
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
