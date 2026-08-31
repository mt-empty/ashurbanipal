import { FilterError, NotAllowedError, quoteIdent } from "./errors.js";

/** Maximum URL-decoded filter JSON bytes (spec/protocol.md §5.4.2). */
export const MAX_FILTER_BYTES = 8192;

/** Maximum conditions per filter request (spec/protocol.md §5.4.2). */
export const MAX_CONDITIONS = 10;

// Wire operators must come from this allow-list before reaching SQL (spec/protocol.md §5.4.2).
const VALID_OPS = new Set(["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"]);

function opTakesValue(op: string): boolean {
  return op !== "IS NULL" && op !== "IS NOT NULL";
}

/** Untrusted filter input; buildWhereClause validates `column` before SQL (spec/protocol.md §5.4.2). */
export interface Condition {
  logic?: "AND" | "OR";
  not?: boolean;
  column: string;
  op: string;
  value?: string;
}

/** Validates JSON ASTs (spec/protocol.md §5.4.2); the frontend parses DSL text (spec/filter-dsl.md). */
export function parseFilter(raw: string): Condition[] {
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

  const conditions: Condition[] = parsed.map((raw, i) => validateConditionShape(raw, i));

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
    const takesValue = opTakesValue(cond.op);
    if (takesValue && cond.value === undefined) {
      throw new FilterError(`op "${cond.op}" requires a value`);
    }
    if (!takesValue && cond.value !== undefined) {
      throw new FilterError(`op "${cond.op}" takes no value`);
    }
  });

  return conditions;
}

// Positional validation stays in parseFilter because it sees the full array.
function validateConditionShape(raw: unknown, index: number): Condition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FilterError(`condition ${index} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["logic", "not", "column", "op", "value"]);
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
  if (obj.value !== undefined && typeof obj.value !== "string") {
    throw new FilterError(`condition ${index} has a non-string "value"`);
  }
  return {
    logic: obj.logic as "AND" | "OR" | undefined,
    not: (obj.not as boolean | undefined) ?? false,
    column: obj.column,
    op: obj.op,
    value: obj.value as string | undefined,
  };
}

// opSql returns a literal allow-listed SQL fragment, never wire text (spec/protocol.md §5.4.2).
function opSql(op: string): string {
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
      throw new Error(`opSql called with an op VALID_OPS should have rejected: ${op}`);
  }
}

export interface WhereClause {
  where: string;
  values: string[];
}

/**
 * Renders conditions into a " where ..." SQL fragment with $N placeholders
 * (numbered starting at startParam, since callers reserve earlier $N slots
 * for limit/offset) and the ordered bind values. Every column is matched
 * against columnNames (the live information_schema allow-list) before
 * being spliced in — the same discipline `sort` gets (spec/protocol.md
 * §6). Conditions are joined by their own logic tokens, relying on SQL's
 * native AND-tighter-than-OR precedence; there is no grouping/nesting in
 * the AST.
 */
export function buildWhereClause(conditions: Condition[], columnNames: string[], startParam: number): WhereClause {
  if (conditions.length === 0) {
    return { where: "", values: [] };
  }

  const allowed = new Set(columnNames);
  const values: string[] = [];
  let clause = "";
  let nextParam = startParam;

  conditions.forEach((cond, i) => {
    if (!allowed.has(cond.column)) {
      throw new NotAllowedError(`column "${cond.column}"`);
    }
    // Defense in depth: buildWhereClause is only ever fed parseFilter's
    // already-op-validated output in production, but it's an exported
    // function a future caller (or a test) could feed conditions to
    // directly — re-checking here is what makes opSql's hardcoded table
    // load-bearing rather than decorative.
    if (!VALID_OPS.has(cond.op)) {
      throw new FilterError(`condition ${i} has invalid op "${cond.op}"`);
    }

    const quotedColumn = quoteIdent(cond.column);
    let inner: string;
    if (opTakesValue(cond.op)) {
      if (cond.value === undefined) {
        throw new FilterError(`op "${cond.op}" requires a value`);
      }
      inner = `${quotedColumn}::text ${opSql(cond.op)} $${nextParam}`;
      values.push(cond.value);
      nextParam++;
    } else {
      inner = `${quotedColumn}::text ${opSql(cond.op)}`;
    }

    const wrapped = cond.not ? `(NOT (${inner}))` : `(${inner})`;

    if (i > 0) {
      if (cond.logic === undefined) {
        throw new FilterError(`condition ${i} is missing logic`);
      }
      clause += cond.logic === "OR" ? " OR " : " AND ";
    }
    clause += wrapped;
  });

  return { where: ` where ${clause}`, values };
}
