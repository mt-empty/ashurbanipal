import { NotAllowedError } from "../errors.js";
import type { Condition } from "../filter.js";
import type { ColMeta, JoinData, JoinOpts, JoinSpec } from "../join.js";

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

/** A §5.4.1 column class, as `class` carries it on the wire. `float`, `json`, `array` and `other` cannot be joined. */
export type ColumnClassName =
  | "number"
  | "text"
  | "uuid"
  | "boolean"
  | "temporal"
  | "time"
  | "binary"
  | "enum"
  | "untyped"
  | "float"
  | "json"
  | "array"
  | "other";

export interface ColumnInfo {
  name: string;
  type: string;
  class: ColumnClassName;
  /** The enumerated type's identity; set only when `class` is "enum". */
  enum_type?: string;
  /** The collation where two text columns can clash (spec/protocol.md §5.4.1). */
  collation?: string;
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

/** The `/api/sources` engine names (`spec/protocol.md` §5.8); MariaDB is `mysql`. */
export type Engine = "postgres" | "mysql" | "sqlite";

/** Database seam; every call is timeout-bounded (`spec/protocol.md` §1, §6). */
export interface DbSource {
  /** A constant per implementation: `/api/sources` never queries the database. */
  readonly engine: Engine;
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

/** Double-quotes a name by doubling embedded `"`; callers pass only names already matched against the live catalog (spec/protocol.md §6). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function findExact(haystack: string[], needle: string): string | undefined {
  return haystack.find((s) => s === needle);
}

/** The catalog's spelling of an allow-listed name; anything else is NotAllowed (`spec/protocol.md` §5.2). */
export function requireExact(allowed: string[], name: string, kind: "schema" | "table" | "column"): string {
  const real = findExact(allowed, name);
  if (real === undefined) throw new NotAllowedError(`${kind} "${name}"`, kind);
  return real;
}

/** The requested schema, or the connection's default when none is requested, checked against the allow-list (`spec/protocol.md` §5). */
export async function pickSchema(
  schemas: string[],
  requested: string | undefined,
  defaultSchema: () => Promise<string | null>,
): Promise<string> {
  const resolved = requested ?? (await defaultSchema());
  if (resolved === null) {
    throw new NotAllowedError("no schema given, and this connection has no default schema", "schema");
  }
  return requireExact(schemas, resolved, "schema");
}

/** Sets a column's key and references; a PK column keeps its FK reference. */
export function applyKeys(col: ColMeta, pkColumns: Set<string>, fkColumns: Map<string, ColumnRef>): void {
  const references = fkColumns.get(col.name);
  if (pkColumns.has(col.name)) col.key = "pk";
  else if (references) col.key = "fk";
  if (references) col.references = references;
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

// Merges each item into the one before it while sameRun holds, turning one
// catalog row per column into one entry per index or constraint. Relies on
// the caller's ORDER BY putting a run's rows adjacent.
export function mergeRuns<T>(items: T[], sameRun: (a: T, b: T) => boolean, merge: (last: T, item: T) => void): T[] {
  const out: T[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last !== undefined && sameRun(last, item)) merge(last, item);
    else out.push(item);
  }
  return out;
}

export const sameName = (a: { name: string }, b: { name: string }): boolean => a.name === b.name;

export function concatColumns<C>(last: { columns: C[] }, item: { columns: C[] }): void {
  last.columns.push(...item.columns);
}

// Merges single-pair ReferencedByEntry rows into one entry per
// (schema, table, constraint). Each backend maps its own row shape (and
// applies any allow-list filter) before calling this.
export function groupReferencedBy(rows: ReferencedByEntry[]): ReferencedByEntry[] {
  return mergeRuns(
    rows,
    (a, b) => a.table === b.table && a.schema === b.schema && a.constraint === b.constraint,
    concatColumns,
  );
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

/** One result row keyed by column name, each cell through cellToJson. */
export function rowToJson(row: Record<string, unknown>, names: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of names) out[name] = cellToJson(row[name]);
  return out;
}
