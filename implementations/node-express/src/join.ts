import type { ColumnClassName, ColumnInfo, ColumnRef, KeyKind } from "./db/types.js";
import { FilterError, NotAllowedError } from "./errors.js";
import {
  type Condition,
  checkValueShape,
  describeForm,
  formAccepts,
  opIsPattern,
  opSql,
  opTakesValue,
  VALID_OPS,
  type ValueForm,
  valueItems,
} from "./filter.js";

/** Bounds for GET /api/tables/join (spec/protocol.md §5.11.1). */
export const MAX_JOIN_BYTES = 8192;
export const MAX_JOIN_TABLES = 4;
export const MAX_JOIN_PAIRS = 3;

/** Anything wrong with a join value (spec/protocol.md §5.11.1): its shape, an unknown table or column, an incompatible pair. Maps to 400 invalid_join. */
export class BadJoinError extends Error {
  constructor(reason: string) {
    super(`invalid join: ${reason}`);
    this.name = "BadJoinError";
  }
}

/** A request parameter outside its allowed values. Maps to 400 invalid_parameter. */
export class BadParamError extends Error {
  constructor(reason: string) {
    super(`invalid parameter: ${reason}`);
    this.name = "BadParamError";
  }
}

/** A table named in the join value is part of the join, so a miss is a bad join; not_readable stays. */
export function unknownJoinTable(err: unknown, table: string): unknown {
  return err instanceof NotAllowedError && err.kind === "table" ? new BadJoinError(`unknown table "${table}"`) : err;
}

export interface ColumnPos {
  join: number;
  column: string;
}

export interface OnPair {
  left: ColumnPos;
  right: string;
}

export interface JoinEntry {
  left: boolean;
  table: string;
  /** Absent means the request's resolved schema. */
  schema?: string;
  on: OnPair[];
}

/** Positions: 0 is `table`, 1.. the entries of `joins` in order. */
export interface JoinSpec {
  table: string;
  /** Absent means the request's resolved schema. */
  schema?: string;
  joins: JoinEntry[];
  columns?: ColumnPos[];
}

export interface TableRef {
  schema?: string;
  table: string;
}

export function joinTableRefs(spec: JoinSpec): TableRef[] {
  return [{ schema: spec.schema, table: spec.table }, ...spec.joins.map((j) => ({ schema: j.schema, table: j.table }))];
}

/**
 * Each position's schema: its own, which must be in `listed` (§5.7), or else
 * `request`. An unlisted one is invalid_join, never unknown_schema, which
 * belongs to the schema parameter.
 */
export function tableSchemas(refs: TableRef[], request: string, listed: string[]): string[] {
  return refs.map((r) => {
    if (r.schema === undefined) return request;
    if (!listed.includes(r.schema)) throw new BadJoinError(`unknown schema "${r.schema}"`);
    return r.schema;
  });
}

function optionalSchema(raw: Record<string, unknown>, what: string): string | undefined {
  if (raw.schema === undefined) return undefined;
  if (typeof raw.schema !== "string") throw new BadJoinError(`${what}: schema must be a string`);
  return raw.schema;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new BadJoinError(`${what} has unknown field "${key}"`);
  }
}

function toPos(raw: unknown, what: string): ColumnPos {
  if (!isObject(raw)) throw new BadJoinError(`${what} must be an object with join and column`);
  checkKeys(raw, ["join", "column"], what);
  if (typeof raw.join !== "number" || !Number.isInteger(raw.join) || raw.join < 0) {
    throw new BadJoinError(`${what}: join must be a non-negative integer position`);
  }
  if (typeof raw.column !== "string") throw new BadJoinError(`${what}: column must be a string`);
  return { join: raw.join, column: raw.column };
}

/** Validates the join object's structure only; names and types are checked by planJoin. */
export function parseJoin(raw: string): JoinSpec {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_JOIN_BYTES) {
    throw new BadJoinError(`join too long: ${bytes} bytes (max ${MAX_JOIN_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BadJoinError(
      `join must be a JSON object of the documented shape: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(parsed)) throw new BadJoinError("join must be a JSON object");
  checkKeys(parsed, ["table", "schema", "joins", "columns"], "join");
  if (typeof parsed.table !== "string") throw new BadJoinError("join needs a string table");
  const schema = optionalSchema(parsed, "join");
  if (!Array.isArray(parsed.joins) || parsed.joins.length === 0) {
    throw new BadJoinError("join needs at least one entry in joins");
  }
  if (parsed.joins.length + 1 > MAX_JOIN_TABLES) {
    throw new BadJoinError(`too many tables: ${parsed.joins.length + 1} (max ${MAX_JOIN_TABLES})`);
  }

  const joins: JoinEntry[] = parsed.joins.map((rawEntry: unknown, i: number) => {
    const position = i + 1;
    if (!isObject(rawEntry)) throw new BadJoinError(`join ${position} must be an object`);
    checkKeys(rawEntry, ["type", "table", "schema", "on"], `join ${position}`);
    if (rawEntry.type !== "inner" && rawEntry.type !== "left") {
      throw new BadJoinError(`join ${position}: type must be "inner" or "left"`);
    }
    if (typeof rawEntry.table !== "string") throw new BadJoinError(`join ${position}: table must be a string`);
    const entrySchema = optionalSchema(rawEntry, `join ${position}`);
    if (!Array.isArray(rawEntry.on) || rawEntry.on.length === 0 || rawEntry.on.length > MAX_JOIN_PAIRS) {
      throw new BadJoinError(`join ${position}: on needs 1 to ${MAX_JOIN_PAIRS} pairs`);
    }
    const on: OnPair[] = rawEntry.on.map((rawPair: unknown) => {
      if (!isObject(rawPair)) throw new BadJoinError(`join ${position}: an on pair must be an object`);
      checkKeys(rawPair, ["left", "right"], `join ${position}: on pair`);
      const left = toPos(rawPair.left, `join ${position}: on.left`);
      if (typeof rawPair.right !== "string") throw new BadJoinError(`join ${position}: on.right must be a string`);
      if (left.join >= position) {
        throw new BadJoinError(
          `join ${position}: on.left refers to position ${left.join}, which is not an earlier table`,
        );
      }
      return { left, right: rawPair.right };
    });
    return { left: rawEntry.type === "left", table: rawEntry.table, schema: entrySchema, on };
  });

  let columns: ColumnPos[] | undefined;
  if (parsed.columns !== undefined) {
    if (!Array.isArray(parsed.columns) || parsed.columns.length === 0) {
      throw new BadJoinError("columns must be a non-empty array when present");
    }
    const seen = new Set<string>();
    columns = parsed.columns.map((c: unknown) => {
      const pos = toPos(c, "columns");
      const key = JSON.stringify([pos.join, pos.column]);
      if (seen.has(key)) throw new BadJoinError(`columns lists (${pos.join}, "${pos.column}") twice`);
      seen.add(key);
      return pos;
    });
  }
  return { table: parsed.table, schema, joins, columns };
}

/**
 * Class of a column type (spec/protocol.md §5.4.1, §5.11.2). `enumType`
 * carries an enumerated type's identity; `untyped` is a SQLite column with
 * no declared type and pairs only with itself.
 */
export interface ColumnClass {
  kind: ColumnClassName;
  enumType?: string;
}

const classKey = (c: ColumnClass): string => `${c.kind}:${c.enumType ?? ""}`;

const NOT_JOINABLE = new Set<ColumnClassName>(["float", "json", "array", "other"]);

/**
 * How a filter compares a column in its own type (spec/protocol.md §5.4.2):
 * the form a value must have, and the engine's cast target for the bound
 * value, from a hardcoded per-engine table (absent binds it bare).
 */
export interface TypedCompare {
  /** Absent skips the value check: SQLite does not enforce column types. */
  form?: ValueForm;
  cast?: string;
  /**
   * The target for a whole number that fits 64 bits, so an integer column
   * keeps its index (Postgres compares int = numeric by converting the column).
   */
  intCast?: string;
}

/**
 * The class of a typed column, read from its value form so a backend's class
 * and typed comparison can't disagree.
 */
export function typedClass(t: TypedCompare | undefined): ColumnClass | undefined {
  switch (t?.form) {
    case "mysql-decimal":
    case "pg-numeric":
      return { kind: "number" };
    case "mysql-float":
    case "pg-float":
      return { kind: "float" };
    case "mysql-date":
    case "mysql-datetime":
    case "pg-date":
    case "pg-timestamp":
    case "pg-timestamptz":
      return { kind: "temporal" };
    case "mysql-time":
    case "pg-time":
    case "pg-timetz":
      return { kind: "time" };
    default:
      return undefined;
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The cast target for one bound value. */
function castFor(t: TypedCompare, v: string): string | undefined {
  if (t.intCast && /^[+-]?[0-9]+$/.test(v)) {
    const n = BigInt(v);
    if (n >= INT64_MIN && n <= INT64_MAX) return t.intCast;
  }
  return t.cast;
}

/** One column as the live catalog reports it. */
export interface ColMeta {
  name: string;
  type: string;
  class: ColumnClass;
  /** Absent: filters compare the column's text cast. */
  compare?: TypedCompare;
  /** Set where two text collations can clash (spec/protocol.md §5.4.1). */
  collation?: string;
  key?: KeyKind;
  references?: ColumnRef;
  comment?: string;
}

export interface TableMeta {
  /** The catalog-checked schema the table is spliced under; absent on SQLite. */
  schema?: string;
  name: string;
  columns: ColMeta[];
  /** Indexes into `columns` that break ties after `sort` (spec/protocol.md §5.4); see tieBreakKeys. */
  orderKeys: number[];
}

/**
 * A unique key a backend's catalog reports for one table. Backends pass a unique
 * index only when its key columns are plain (no expression), it is not partial,
 * and every key column is NOT NULL.
 */
export interface UniqueKey {
  name: string;
  primary: boolean;
  columns: string[];
}

/**
 * The primary key's column indexes in key order, else those of the unique key
 * with the fewest columns (then the lowest name). A key with a column the role
 * cannot see is skipped; none left means no tie-break.
 */
export function tieBreakKeys(columns: ColMeta[], keys: UniqueKey[]): number[] {
  const usable = keys
    .map((k) => ({ k, idx: k.columns.map((name) => columns.findIndex((c) => c.name === name)) }))
    .filter(({ idx }) => idx.length > 0 && idx.every((i) => i >= 0));
  usable.sort(
    (a, b) =>
      Number(b.k.primary) - Number(a.k.primary) ||
      a.idx.length - b.idx.length ||
      (a.k.name < b.k.name ? -1 : a.k.name > b.k.name ? 1 : 0),
  );
  return usable[0]?.idx ?? [];
}

/** One key column of a candidate unique key; `usable` is false when it rules the key out. */
export interface KeyPart {
  index: string;
  primary: boolean;
  column: string;
  usable: boolean;
}

/** Folds parts, ordered by index and then key position, into keys, dropping a key with an unusable part. */
export function groupUniqueKeys(parts: KeyPart[]): UniqueKey[] {
  const keys: (UniqueKey & { usable: boolean })[] = [];
  for (const p of parts) {
    let last = keys[keys.length - 1];
    if (!last || last.name !== p.index) {
      last = { name: p.index, primary: p.primary, columns: [], usable: true };
      keys.push(last);
    }
    last.columns.push(p.column);
    last.usable &&= p.usable;
  }
  return keys.filter((k) => k.usable).map(({ name, primary, columns }) => ({ name, primary, columns }));
}

/**
 * A single-table query's order by, every column qualified by the table name so
 * it never resolves to a text-cast output column.
 */
export function tableOrderClause(
  meta: TableMeta,
  sort: string | undefined,
  descending: boolean,
  quote: (name: string) => string,
): string {
  const i = sort === undefined ? -1 : meta.columns.findIndex((c) => c.name === sort);
  return orderByClause(
    i < 0 ? undefined : i,
    meta.orderKeys,
    descending,
    (k) => `${quote(meta.name)}.${quote(meta.columns[k].name)}`,
  );
}

/**
 * ` order by <sort>, <keys…>` with a key equal to `sort` left out, every term in
 * one direction (asc when there is no sort); "" when there is nothing to order
 * by. `same` compares keys.
 */
export function orderByClause<T>(
  sort: T | undefined,
  keys: T[],
  descending: boolean,
  render: (key: T) => string,
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): string {
  const dir = descending && sort !== undefined ? "desc" : "asc";
  const lead: T[] = sort === undefined ? [] : [sort];
  const terms = lead.concat(keys.filter((k) => sort === undefined || !same(k, sort))).map((k) => `${render(k)} ${dir}`);
  return terms.length === 0 ? "" : ` order by ${terms.join(", ")}`;
}

export interface JoinOpts {
  limit: number;
  offset: number;
  sort?: string;
  sortJoin?: number;
  descending: boolean;
  /** Conditions may carry a table position (spec/protocol.md §5.11.3). */
  filter: Condition[];
}

export interface JoinColumnInfo {
  name: string;
  type: string;
  join: number;
  table: string;
  schema?: string;
  column: string;
  class: ColumnClassName;
  collation?: string;
  enum_type?: string;
  key?: KeyKind;
  references?: ColumnRef;
  comment?: string;
}

export interface JoinData {
  columns: JoinColumnInfo[];
  rows: Record<string, string | null>[];
  has_more: boolean;
}

interface ResolvedCondition {
  cond: Condition;
  pos: number;
  col: number;
}

/** A request resolved against the catalog; every name in SQL text comes from `tables`, never the request. */
export interface JoinPlan {
  tables: TableMeta[];
  left: boolean[];
  /** Per join entry: [left position, left column, right column]. */
  ons: [number, number, number][][];
  /** [position, column index] per returned column. */
  selection: [number, number][];
  labels: string[];
  filter: ResolvedCondition[];
  sort?: [number, number];
  descending: boolean;
}

function columnIndex(table: TableMeta, column: string): number {
  const i = table.columns.findIndex((c) => c.name === column);
  if (i < 0) throw new NotAllowedError(`column "${column}"`, "column");
  return i;
}

// A name inside the join value: a miss is a bad join, not unknown_column.
function joinColumnIndex(table: TableMeta, column: string): number {
  const i = table.columns.findIndex((c) => c.name === column);
  if (i < 0) throw new BadJoinError(`${table.name} has no column "${column}"`);
  return i;
}

const describe = (t: TableMeta, c: ColMeta): string => `${t.name}.${c.name} (${c.type})`;

function unjoinable(position: number, t: TableMeta, c: ColMeta): BadJoinError {
  const why = c.class.kind === "float" ? ": floating-point values are not compared exactly" : "";
  return new BadJoinError(`join ${position} on: ${describe(t, c)} cannot be used in a join${why}`);
}

function checkPair(position: number, lt: TableMeta, lc: ColMeta, rt: TableMeta, rc: ColMeta): void {
  if (NOT_JOINABLE.has(lc.class.kind)) throw unjoinable(position, lt, lc);
  if (NOT_JOINABLE.has(rc.class.kind)) throw unjoinable(position, rt, rc);
  if (classKey(lc.class) !== classKey(rc.class)) {
    throw new BadJoinError(`join ${position} on: ${describe(lt, lc)} cannot be joined to ${describe(rt, rc)}`);
  }
  if (lc.class.kind === "text" && lc.collation && rc.collation && lc.collation !== rc.collation) {
    throw new BadJoinError(
      `join ${position} on: ${describe(lt, lc)} and ${describe(rt, rc)} use different text collations (${lc.collation} and ${rc.collation})`,
    );
  }
}

/**
 * A column keeps its own name when that is unique among the returned
 * columns, otherwise it becomes `{name}_{join}`; a numeric suffix breaks any
 * remaining tie.
 */
export function assignJoinLabels(names: string[], joins: number[]): string[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const used = new Set<string>(names.filter((n) => counts.get(n) === 1));
  return names.map((n, i) => {
    if (counts.get(n) === 1) return n;
    const base = `${n}_${joins[i]}`;
    let label = base;
    for (let k = 2; used.has(label); k++) label = `${base}_${k}`;
    used.add(label);
    return label;
  });
}

/** Resolves a request against the catalog; `tables[i]` is the metadata of position i. */
export function planJoin(spec: JoinSpec, tables: TableMeta[], opts: JoinOpts): JoinPlan {
  const left: boolean[] = [];
  const ons: [number, number, number][][] = [];
  spec.joins.forEach((entry, i) => {
    const position = i + 1;
    left.push(entry.left);
    ons.push(
      entry.on.map((pair) => {
        const lt = tables[pair.left.join];
        const lc = joinColumnIndex(lt, pair.left.column);
        const rc = joinColumnIndex(tables[position], pair.right);
        checkPair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc]);
        return [pair.left.join, lc, rc];
      }),
    );
  });

  let selection: [number, number][];
  if (spec.columns) {
    selection = spec.columns.map((c) => {
      if (c.join >= tables.length) throw new BadJoinError(`columns: position ${c.join} is not in the join`);
      return [c.join, joinColumnIndex(tables[c.join], c.column)];
    });
  } else {
    selection = tables.flatMap((t, pos) => t.columns.map((_, col): [number, number] => [pos, col]));
  }
  const labels = assignJoinLabels(
    selection.map(([p, c]) => tables[p].columns[c].name),
    selection.map(([p]) => p),
  );

  const filter = opts.filter.map((cond, i): ResolvedCondition => {
    const pos = cond.join ?? 0;
    if (!Number.isInteger(pos) || pos < 0 || pos >= tables.length) {
      throw new FilterError(`condition ${i}: join position ${pos} is not in the join`);
    }
    checkValueShape(cond, i);
    const col = columnIndex(tables[pos], cond.column);
    checkTypedValues(tables[pos].columns[col], cond);
    return { cond, pos, col };
  });

  let sort: [number, number] | undefined;
  if (opts.sort === undefined && opts.sortJoin !== undefined) throw new BadParamError("sort_join needs sort");
  if (opts.sort !== undefined) {
    const pos = opts.sortJoin ?? 0;
    if (pos < 0 || pos >= tables.length) throw new BadParamError(`sort_join: position ${pos} is not in the join`);
    sort = [pos, columnIndex(tables[pos], opts.sort)];
  }
  return { tables, left, ons, selection, labels, filter, sort, descending: opts.descending };
}

export type IlikeStyle = "native" | "like" | "lowered-like";

/** How a backend spells the pieces that differ between engines. */
export interface JoinDialect {
  quote(name: string): string;
  castText(expr: string): string;
  /** Converts a bound placeholder to a {@link TypedCompare} cast target. */
  castParam(placeholder: string, target: string): string;
  /** `$n` placeholders (Postgres) instead of `?`. */
  numbered: boolean;
  ilike: IlikeStyle;
}

/** The column-typed half of the spec/protocol.md §5.4.2 value check. */
function checkTypedValues(col: ColMeta, cond: Condition): void {
  const form = col.compare?.form;
  if (!form || opIsPattern(cond.op)) return;
  const bad = valueItems(cond).find((v) => !formAccepts(form, v));
  if (bad !== undefined) {
    throw new FilterError(
      `value ${JSON.stringify(bad)} for column ${JSON.stringify(col.name)} must be ${describeForm(form)}`,
    );
  }
}

/** One condition with its column resolved; `expr` is the column as SQL. */
interface FilterTerm {
  cond: Condition;
  expr: string;
  col: ColMeta;
}

/**
 * The conditions joined by their logic, without `where`, and the values in
 * placeholder order. Numbered placeholders start at $3, after limit and offset.
 */
function filterSql(terms: FilterTerm[], d: JoinDialect): { clause: string; values: string[] } {
  const values: string[] = [];
  let next = 3;
  let clause = "";
  terms.forEach(({ cond, expr, col }, i) => {
    const typed = opIsPattern(cond.op) ? undefined : col.compare;
    const placeholder = (v: string): string => {
      const p = d.numbered ? `$${next++}` : "?";
      const target = typed && castFor(typed, v);
      return target ? d.castParam(p, target) : p;
    };
    const lhs = typed ? expr : d.castText(expr);
    const items = valueItems(cond);
    let inner: string;
    if (!opTakesValue(cond.op)) {
      inner = `${lhs} ${opSql(cond.op)}`;
    } else if (cond.op === "IN") {
      inner = `${lhs} IN (${items.map((v) => placeholder(v)).join(", ")})`;
    } else if (cond.op === "BETWEEN") {
      const [lo, hi] = items as [string, string];
      inner = `${lhs} BETWEEN ${placeholder(lo)} AND ${placeholder(hi)}`;
    } else {
      const v = items[0] as string;
      if (cond.op === "ILIKE") {
        if (d.ilike === "native") inner = `${lhs} ILIKE ${placeholder(v)}`;
        else if (d.ilike === "like") inner = `${lhs} LIKE ${placeholder(v)}`;
        else inner = `LOWER(${lhs}) LIKE LOWER(${placeholder(v)})`;
      } else {
        inner = `${lhs} ${opSql(cond.op)} ${placeholder(v)}`;
      }
    }
    values.push(...items);
    if (i > 0) clause += cond.logic === "OR" ? " OR " : " AND ";
    clause += cond.not ? `(NOT (${inner}))` : `(${inner})`;
  });
  return { clause, values };
}

/**
 * The data route's ` where …` ("" without conditions) and its values, with
 * each condition's column checked against the live catalog's columns
 * (spec/protocol.md §5.4.2).
 */
export function tableWhereClause(
  conditions: Condition[],
  table: TableMeta,
  d: JoinDialect,
): { where: string; values: string[] } {
  const terms = conditions.map((cond, i): FilterTerm => {
    const col = table.columns[columnIndex(table, cond.column)];
    // Defends the SQL boundary when a caller bypasses parseFilter.
    if (!VALID_OPS.has(cond.op)) throw new FilterError(`condition ${i} has invalid op "${cond.op}"`);
    checkValueShape(cond, i);
    if (i > 0 && cond.logic === undefined) throw new FilterError(`condition ${i} is missing logic`);
    checkTypedValues(col, cond);
    return { cond, expr: d.quote(col.name), col };
  });
  const { clause, values } = filterSql(terms, d);
  return { where: clause ? ` where ${clause}` : "", values };
}

/**
 * Each table's tie-break key as `[position, column]`, in position order. A key
 * whose every column an `on` pair binds, at the same type and collation, to a
 * table already fixed by earlier keys is left out: it cannot change the order
 * (spec/protocol.md §5.11.3).
 */
export function joinOrderKeys(tables: TableMeta[], ons: [number, number, number][][]): [number, number][] {
  const fixed: boolean[] = [];
  const keys: [number, number][] = [];
  tables.forEach((t, p) => {
    const bound =
      p > 0 &&
      t.orderKeys.length > 0 &&
      t.orderKeys.every((k) =>
        ons[p - 1].some(([lp, lc, rc]) => {
          const l = tables[lp].columns[lc];
          const r = t.columns[rc];
          return rc === k && fixed[lp] && l.type === r.type && l.collation === r.collation;
        }),
      );
    if (!bound) for (const c of t.orderKeys) keys.push([p, c]);
    fixed.push(t.orderKeys.length > 0);
  });
  return keys;
}

/**
 * Renders `<select list> from … limit … offset …` (no leading `select`, so
 * MySQL can wrap it in its timeout hint) and the filter values in
 * placeholder order. Numbered dialects reserve $1/$2 for limit and offset;
 * others bind filter values first, then limit, then offset.
 */
export function buildJoinSelect(plan: JoinPlan, d: JoinDialect): { body: string; values: string[] } {
  const alias = (pos: number, col: number): string => `t${pos}.${d.quote(plan.tables[pos].columns[col].name)}`;
  const selectList = plan.selection.map(([p, c], i) => `${d.castText(alias(p, c))} as c${i}`).join(", ");
  const fromItem = (pos: number): string => {
    const { schema, name } = plan.tables[pos];
    return schema !== undefined ? `${d.quote(schema)}.${d.quote(name)} t${pos}` : `${d.quote(name)} t${pos}`;
  };

  let sql = `${selectList} from ${fromItem(0)}`;
  plan.left.forEach((isLeft, i) => {
    const position = i + 1;
    // Right column first: SQLite compares with the left operand's collation, which key pruning (joinOrderKeys) relies on.
    const on = plan.ons[i].map(([lp, lc, rc]) => `${alias(position, rc)} = ${alias(lp, lc)}`).join(" and ");
    sql += ` ${isLeft ? "left join" : "inner join"} ${fromItem(position)} on ${on}`;
  });

  const { clause, values } = filterSql(
    plan.filter.map(({ cond, pos, col }) => ({ cond, expr: alias(pos, col), col: plan.tables[pos].columns[col] })),
    d,
  );
  if (clause) sql += ` where ${clause}`;
  sql += orderByClause(
    plan.sort,
    joinOrderKeys(plan.tables, plan.ons),
    plan.descending,
    ([p, c]) => alias(p, c),
    (a, b) => a[0] === b[0] && a[1] === b[1],
  );
  sql += d.numbered ? " limit $1 offset $2" : " limit ? offset ?";
  return { body: sql, values };
}

/** The §5.4.1 shape of a column. */
export function columnInfo(col: ColMeta): ColumnInfo {
  const info: ColumnInfo = { name: col.name, type: col.type, class: col.class.kind };
  if (col.class.enumType) info.enum_type = col.class.enumType;
  if (col.collation && col.class.kind === "text") info.collation = col.collation;
  if (col.key) info.key = col.key;
  if (col.references) info.references = col.references;
  if (col.comment) info.comment = col.comment;
  return info;
}

/** A column's `schema` is reported only when its table is outside `requestSchema`. */
export function joinColumnInfos(plan: JoinPlan, requestSchema: string): JoinColumnInfo[] {
  return plan.selection.map(([p, c], i) => {
    const t = plan.tables[p];
    const { name, ...rest } = columnInfo(t.columns[c]);
    const info: JoinColumnInfo = { name: plan.labels[i], ...rest, join: p, table: t.name, column: name };
    if (t.schema !== undefined && t.schema !== requestSchema) info.schema = t.schema;
    return info;
  });
}

/** Keys result rows (selected as c0, c1, …) by label and trims the extra row asked for has_more. */
export function joinRows(
  plan: JoinPlan,
  rows: Record<string, unknown>[],
  limit: number,
  cell: (value: unknown) => string | null,
): { rows: Record<string, string | null>[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const out = rows.slice(0, limit).map((row) => {
    const o: Record<string, string | null> = {};
    plan.labels.forEach((label, i) => {
      o[label] = cell(row[`c${i}`]);
    });
    return o;
  });
  return { rows: out, hasMore };
}
