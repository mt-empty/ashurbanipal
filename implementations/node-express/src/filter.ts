import { FilterError } from "./errors.js";

/** Maximum URL-decoded filter JSON bytes (spec/protocol.md §5.4.2). */
export const MAX_FILTER_BYTES = 8192;

/** Maximum conditions per filter request (spec/protocol.md §5.4.2). */
export const MAX_CONDITIONS = 10;

/** Maximum items in an IN list (spec/protocol.md §5.4.2). */
export const MAX_IN_ITEMS = 1000;

// Wire operators must come from this allow-list before reaching SQL (spec/protocol.md §5.4.2).
export const VALID_OPS = new Set([
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "ILIKE",
  "IN",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
]);

export function opTakesValue(op: string): boolean {
  return op !== "IS NULL" && op !== "IS NOT NULL";
}

// The hardcoded operator -> SQL-keyword table (spec/protocol.md §5.4.2) —
// wire text never becomes an operator except through this match. join.ts's
// filterSql wraps the keyword in each engine's cast and placeholder syntax,
// and spells IN, BETWEEN and ILIKE itself.
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
    case "IN":
      return "IN";
    case "BETWEEN":
      return "BETWEEN";
    case "IS NULL":
      return "IS NULL";
    case "IS NOT NULL":
      return "IS NOT NULL";
    default:
      throw new Error(`opSql called with an op the caller should have validated: ${op}`);
  }
}

/** LIKE/ILIKE always compare the text cast, whatever the column's class. */
export function opIsPattern(op: string): boolean {
  return op === "LIKE" || op === "ILIKE";
}

/** Untrusted filter input; tableWhereClause validates `column` before SQL (spec/protocol.md §5.4.2). */
export interface Condition {
  logic?: "AND" | "OR";
  not?: boolean;
  column: string;
  op: string;
  /** A string for most ops; an array of strings for IN and BETWEEN. */
  value?: string | string[];
  /** Table position, accepted only by {@link parseFilterForJoin} (spec/protocol.md §5.11.3). */
  join?: number;
}

/** Validates JSON ASTs (spec/protocol.md §5.4.2); the frontend parses DSL text (spec/filter-dsl.md). */
export function parseFilter(raw: string): Condition[] {
  return parseFilterInner(raw, false);
}

/** {@link parseFilter} for GET /api/tables/join: a condition may carry a `join` table position. */
export function parseFilterForJoin(raw: string): Condition[] {
  return parseFilterInner(raw, true);
}

function parseFilterInner(raw: string, allowJoin: boolean): Condition[] {
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > MAX_FILTER_BYTES) {
    throw new FilterError(`filter too long: ${byteLength} bytes (max ${MAX_FILTER_BYTES})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FilterError(
      `filter must be a JSON array of conditions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FilterError("filter must be a JSON array of conditions");
  }
  if (parsed.length > MAX_CONDITIONS) {
    throw new FilterError(`too many conditions: ${parsed.length} (max ${MAX_CONDITIONS})`);
  }

  const conditions: Condition[] = parsed.map((raw, i) => validateConditionShape(raw, i, allowJoin));

  conditions.forEach((cond, i) => {
    if (i === 0 && cond.logic !== undefined) {
      throw new FilterError("logic must be absent on the first condition");
    }
    if (i > 0 && cond.logic === undefined) {
      throw new FilterError(`condition ${i} is missing logic ("AND" or "OR")`);
    }
    if (cond.logic !== undefined && cond.logic !== "AND" && cond.logic !== "OR") {
      throw new FilterError(`condition ${i} has invalid logic "${String(cond.logic)}"`);
    }
    if (!VALID_OPS.has(cond.op)) {
      throw new FilterError(`condition ${i} has invalid op "${cond.op}"`);
    }
    checkValueShape(cond, i);
  });

  return conditions;
}

// Positional validation stays in parseFilter because it sees the full array.
function validateConditionShape(raw: unknown, index: number, allowJoin: boolean): Condition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FilterError(`condition ${index} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["logic", "not", "column", "op", "value", ...(allowJoin ? ["join"] : [])]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new FilterError(`condition ${index} has unknown field "${key}"`);
    }
  }
  if (typeof obj.column !== "string") {
    throw new FilterError(`condition ${index} is missing a string "column"`);
  }
  if (typeof obj.op !== "string") {
    throw new FilterError(`condition ${index} is missing a string "op"`);
  }
  if (obj.logic !== undefined && typeof obj.logic !== "string") {
    throw new FilterError(`condition ${index} has a non-string "logic"`);
  }
  if (obj.not !== undefined && typeof obj.not !== "boolean") {
    throw new FilterError(`condition ${index} has a non-boolean "not"`);
  }
  if (
    obj.value !== undefined &&
    typeof obj.value !== "string" &&
    !(Array.isArray(obj.value) && obj.value.every((v) => typeof v === "string"))
  ) {
    throw new FilterError(`condition ${index} has a "value" that is neither a string nor an array of strings`);
  }
  if (obj.join !== undefined && (typeof obj.join !== "number" || !Number.isInteger(obj.join) || obj.join < 0)) {
    throw new FilterError(`condition ${index} has an invalid "join" position`);
  }
  return {
    logic: obj.logic as "AND" | "OR" | undefined,
    not: (obj.not as boolean | undefined) ?? false,
    column: obj.column,
    op: obj.op,
    value: obj.value as string | string[] | undefined,
    ...(obj.join !== undefined ? { join: obj.join as number } : {}),
  };
}

/** Checks a condition's value against its op (spec/protocol.md §5.4.2). */
export function checkValueShape(cond: Condition, index: number): void {
  const fail = (why: string): never => {
    throw new FilterError(`condition ${index}: ${why}`);
  };
  const { op, value } = cond;
  if (!opTakesValue(op)) {
    if (value !== undefined) fail(`op "${op}" takes no value`);
    return;
  }
  if (value === undefined) fail(`op "${op}" requires a value`);
  if (op === "IN") {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IN_ITEMS) {
      fail(`op "IN" needs an array of 1 to ${MAX_IN_ITEMS} strings`);
    }
  } else if (op === "BETWEEN") {
    if (!Array.isArray(value) || value.length !== 2) fail(`op "BETWEEN" needs an array of two strings, [low, high]`);
  } else if (Array.isArray(value)) {
    fail(`op "${op}" needs a string value`);
  }
}

/** A condition's value as a list (one item for a string value). */
export function valueItems(cond: Condition): string[] {
  if (cond.value === undefined) return [];
  return Array.isArray(cond.value) ? cond.value : [cond.value];
}

/** The form a value compared in its column's own type must have (spec/protocol.md §5.4.2). */
export type ValueForm =
  | "mysql-decimal"
  | "mysql-float"
  | "mysql-date"
  | "mysql-datetime"
  | "mysql-time"
  | "pg-numeric"
  | "pg-float"
  | "pg-date"
  | "pg-timestamp"
  | "pg-timestamptz"
  | "pg-time"
  | "pg-timetz";

// Each form is the common one widened to every value its engine stores and
// renders (spec/protocol.md §5.4.2), so a cell's own text always filters
// back to its row.
const CLOCK_TAIL = String.raw`:[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?`;
const PG_CLOCK = String.raw`(([01][0-9]|2[0-3])${CLOCK_TAIL}|24:00(:00(\.0{1,6})?)?)`;
const TZ_OFFSET = String.raw`(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?`;
const MYSQL_DECIMAL_RE = /^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?$/;
const MYSQL_FLOAT_RE = /^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?$/;
const MYSQL_TIME_RE = new RegExp(String.raw`^-?([0-9]{2,3})${CLOCK_TAIL}$`);
const PG_NUMERIC_RE = /^[+-]?[0-9]+(\.[0-9]+)?$/;
const PG_FLOAT_RE = /^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]{1,3})?$/;
const PG_SPECIAL_NUMBER_RE = /^(nan|[+-]?infinity)$/i;
const PG_INFINITY_RE = /^-?infinity$/i;
const TIME_RE = new RegExp(String.raw`^([01][0-9]|2[0-3])${CLOCK_TAIL}$`);
const PG_TIME_RE = new RegExp(`^${PG_CLOCK}$`);
const PG_TIME_TZ_RE = new RegExp(`^${PG_CLOCK}${TZ_OFFSET}$`);

/**
 * A real YYYY-MM-DD date from year 0001; `wideYears` allows up to 7 year
 * digits. A `bc` year counts back from 1 BC, which is a leap year.
 */
function calendarDate(s: string, wideYears: boolean, bc: boolean): boolean {
  const m = /^([0-9]{4,7})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (!m || (!wideYears && m[1].length !== 4)) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const ly = bc ? y - 1 : y;
  const leap = ly % 4 === 0 && (ly % 100 !== 0 || ly % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

const mysqlDate = (s: string): boolean => s === "0000-00-00" || calendarDate(s, false, false);

/** A date accepted by `dateOk`, optionally followed by a space or `T` and a time accepted by `timeOk`. */
function timestampOf(v: string, dateOk: (d: string) => boolean, timeOk: (t: string) => boolean): boolean {
  const i = v.search(/[ T]/);
  return i < 0 ? dateOk(v) : dateOk(v.slice(0, i)) && timeOk(v.slice(i + 1));
}

/** Calls `f` with `v` minus a trailing ` BC`, and whether it had one. */
function pgDateBc(v: string, f: (rest: string, bc: boolean) => boolean): boolean {
  return v.endsWith(" BC") ? f(v.slice(0, -3), true) : f(v, false);
}

function pgTimestamp(v: string, time: RegExp): boolean {
  return (
    PG_INFINITY_RE.test(v) ||
    pgDateBc(v, (t, bc) =>
      timestampOf(
        t,
        (d) => calendarDate(d, true, bc),
        (c) => time.test(c),
      ),
    )
  );
}

export function formAccepts(form: ValueForm, v: string): boolean {
  switch (form) {
    case "mysql-decimal":
      return MYSQL_DECIMAL_RE.test(v);
    case "mysql-float":
      return MYSQL_FLOAT_RE.test(v);
    case "mysql-date":
      return mysqlDate(v);
    case "mysql-datetime":
      return timestampOf(v, mysqlDate, (t) => TIME_RE.test(t));
    case "mysql-time": {
      const m = MYSQL_TIME_RE.exec(v);
      return m !== null && Number(m[1]) <= 838;
    }
    case "pg-numeric":
      return PG_SPECIAL_NUMBER_RE.test(v) || PG_NUMERIC_RE.test(v);
    case "pg-float":
      return PG_SPECIAL_NUMBER_RE.test(v) || PG_FLOAT_RE.test(v);
    case "pg-date":
      return PG_INFINITY_RE.test(v) || pgDateBc(v, (d, bc) => calendarDate(d, true, bc));
    case "pg-timestamp":
      return pgTimestamp(v, PG_TIME_RE);
    case "pg-timestamptz":
      return pgTimestamp(v, PG_TIME_TZ_RE);
    case "pg-time":
      return PG_TIME_RE.test(v);
    case "pg-timetz":
      return PG_TIME_TZ_RE.test(v);
  }
}

/** Names the expected form in an error title. */
export function describeForm(form: ValueForm): string {
  switch (form) {
    case "mysql-decimal":
      return "a decimal number such as -12 or 0.5";
    case "mysql-float":
      return "a number such as 0.5 or 1.5e-3";
    case "mysql-date":
      return "a date such as 2016-01-31";
    case "mysql-datetime":
    case "pg-timestamp":
      return "a date such as 2016-01-31, optionally with a time such as 10:30:00";
    case "mysql-time":
      return "a time such as 10:30 or -100:00:00";
    case "pg-numeric":
      return "a decimal number such as -12, 0.5 or NaN";
    case "pg-float":
      return "a number such as 0.5, 1.5e-3 or Infinity";
    case "pg-date":
      return "a date such as 2016-01-31, 0044-03-15 BC or infinity";
    case "pg-timestamptz":
      return "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00";
    case "pg-time":
      return "a time such as 10:30 or 10:30:00.5";
    case "pg-timetz":
      return "a time such as 10:30, optionally with an offset such as +02:00";
  }
}
