import { type ColumnRef, type KeyKind, opSql, opTakesValue } from "./db/types.js";
import { FilterError, NotAllowedError } from "./errors.js";
import type { Condition } from "./filter.js";

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
  on: OnPair[];
}

/** Positions: 0 is `table`, 1.. the entries of `joins` in order. */
export interface JoinSpec {
  table: string;
  joins: JoinEntry[];
  columns?: ColumnPos[];
}

export function joinTableNames(spec: JoinSpec): string[] {
  return [spec.table, ...spec.joins.map((j) => j.table)];
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
  checkKeys(parsed, ["table", "joins", "columns"], "join");
  if (typeof parsed.table !== "string") throw new BadJoinError("join needs a string table");
  if (!Array.isArray(parsed.joins) || parsed.joins.length === 0) {
    throw new BadJoinError("join needs at least one entry in joins");
  }
  if (parsed.joins.length + 1 > MAX_JOIN_TABLES) {
    throw new BadJoinError(`too many tables: ${parsed.joins.length + 1} (max ${MAX_JOIN_TABLES})`);
  }

  const joins: JoinEntry[] = parsed.joins.map((rawEntry: unknown, i: number) => {
    const position = i + 1;
    if (!isObject(rawEntry)) throw new BadJoinError(`join ${position} must be an object`);
    checkKeys(rawEntry, ["type", "table", "on"], `join ${position}`);
    if (rawEntry.type !== "inner" && rawEntry.type !== "left") {
      throw new BadJoinError(`join ${position}: type must be "inner" or "left"`);
    }
    if (typeof rawEntry.table !== "string") throw new BadJoinError(`join ${position}: table must be a string`);
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
    return { left: rawEntry.type === "left", table: rawEntry.table, on };
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
  return { table: parsed.table, joins, columns };
}

/**
 * Comparison class of a column type (spec/protocol.md §5.11.2). `id`
 * carries an enumerated type's identity; `untyped` is a SQLite column with
 * no declared type and pairs only with itself.
 */
export interface TypeClass {
  kind: "number" | "text" | "uuid" | "boolean" | "temporal" | "time" | "binary" | "enum" | "untyped";
  id?: string;
}

const classKey = (c: TypeClass): string => `${c.kind}:${c.id ?? ""}`;

/** One column as the live catalog reports it. */
export interface JoinColMeta {
  name: string;
  type: string;
  class?: TypeClass;
  /** Set where two text collations can clash (MySQL). */
  collation?: string;
  key?: KeyKind;
  references?: ColumnRef;
  comment?: string;
}

export interface JoinTableMeta {
  name: string;
  columns: JoinColMeta[];
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
  column: string;
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
  tables: JoinTableMeta[];
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

function columnIndex(table: JoinTableMeta, column: string): number {
  const i = table.columns.findIndex((c) => c.name === column);
  if (i < 0) throw new NotAllowedError(`column "${column}"`, "column");
  return i;
}

// A name inside the join value: a miss is a bad join, not unknown_column.
function joinColumnIndex(table: JoinTableMeta, column: string): number {
  const i = table.columns.findIndex((c) => c.name === column);
  if (i < 0) throw new BadJoinError(`${table.name} has no column "${column}"`);
  return i;
}

const describe = (t: JoinTableMeta, c: JoinColMeta): string => `${t.name}.${c.name} (${c.type})`;

function unjoinable(position: number, t: JoinTableMeta, c: JoinColMeta): BadJoinError {
  const why = /real|float|double/i.test(c.type) ? ": floating-point values are not compared exactly" : "";
  return new BadJoinError(`join ${position} on: ${describe(t, c)} cannot be used in a join${why}`);
}

function checkPair(position: number, lt: JoinTableMeta, lc: JoinColMeta, rt: JoinTableMeta, rc: JoinColMeta): void {
  if (!lc.class) throw unjoinable(position, lt, lc);
  if (!rc.class) throw unjoinable(position, rt, rc);
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
export function planJoin(spec: JoinSpec, tables: JoinTableMeta[], opts: JoinOpts): JoinPlan {
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
    if (opTakesValue(cond.op) !== (cond.value !== undefined)) {
      throw new FilterError(`condition ${i}: op "${cond.op}" has the wrong value arity`);
    }
    return { cond, pos, col: columnIndex(tables[pos], cond.column) };
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
  /** `$n` placeholders (Postgres) instead of `?`. */
  numbered: boolean;
  ilike: IlikeStyle;
}

/**
 * Renders `<select list> from … limit … offset …` (no leading `select`, so
 * MySQL can wrap it in its timeout hint) and the filter values in
 * placeholder order. Numbered dialects reserve $1/$2 for limit and offset;
 * others bind filter values first, then limit, then offset.
 */
export function buildJoinSelect(
  plan: JoinPlan,
  d: JoinDialect,
  schema: string | undefined,
): { body: string; values: string[] } {
  const alias = (pos: number, col: number): string => `t${pos}.${d.quote(plan.tables[pos].columns[col].name)}`;
  const selectList = plan.selection.map(([p, c], i) => `${d.castText(alias(p, c))} as c${i}`).join(", ");
  const fromItem = (pos: number): string => {
    const name = d.quote(plan.tables[pos].name);
    return schema !== undefined ? `${d.quote(schema)}.${name} t${pos}` : `${name} t${pos}`;
  };

  let sql = `${selectList} from ${fromItem(0)}`;
  plan.left.forEach((isLeft, i) => {
    const position = i + 1;
    const on = plan.ons[i].map(([lp, lc, rc]) => `${alias(position, rc)} = ${alias(lp, lc)}`).join(" and ");
    sql += ` ${isLeft ? "left join" : "inner join"} ${fromItem(position)} on ${on}`;
  });

  const values: string[] = [];
  let next = 3;
  const placeholder = (): string => (d.numbered ? `$${next++}` : "?");
  let clause = "";
  plan.filter.forEach(({ cond, pos, col }, i) => {
    const cast = d.castText(alias(pos, col));
    let inner: string;
    if (!opTakesValue(cond.op)) {
      inner = `${cast} ${opSql(cond.op)}`;
    } else if (cond.op === "ILIKE") {
      values.push(cond.value as string);
      if (d.ilike === "native") inner = `${cast} ILIKE ${placeholder()}`;
      else if (d.ilike === "like") inner = `${cast} LIKE ${placeholder()}`;
      else inner = `LOWER(${cast}) LIKE LOWER(${placeholder()})`;
    } else {
      values.push(cond.value as string);
      inner = `${cast} ${opSql(cond.op)} ${placeholder()}`;
    }
    if (i > 0) clause += cond.logic === "OR" ? " OR " : " AND ";
    clause += cond.not ? `(NOT (${inner}))` : `(${inner})`;
  });
  if (clause) sql += ` where ${clause}`;
  if (plan.sort) {
    sql += ` order by ${alias(plan.sort[0], plan.sort[1])} ${plan.descending ? "desc" : "asc"}`;
  }
  sql += d.numbered ? " limit $1 offset $2" : " limit ? offset ?";
  return { body: sql, values };
}

export function joinColumnInfos(plan: JoinPlan): JoinColumnInfo[] {
  return plan.selection.map(([p, c], i) => {
    const t = plan.tables[p];
    const col = t.columns[c];
    const info: JoinColumnInfo = { name: plan.labels[i], type: col.type, join: p, table: t.name, column: col.name };
    if (col.key) info.key = col.key;
    if (col.references) info.references = col.references;
    if (col.comment) info.comment = col.comment;
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
