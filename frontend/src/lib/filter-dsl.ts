import type { FilterCondition, FilterOp } from "../core/types.js";

// ==== Filter DSL parser (box text → wire AST) ====
// The single canonical implementation of spec/filter-dsl.md — no backend
// (reference or port) parses DSL text; they all consume the AST this
// emits (spec/protocol.md §5.4.2). Iterative — one flat condition loop,
// no recursive descent — so pathological input can't grow the call stack
// (filter-dsl.md A9). Error positions are UTF-8 byte offsets into the
// input, same convention the DSL-era backend parser reported.
const FILTER_MAX_DSL_BYTES = 1024;
const FILTER_MAX_CONDITIONS = 10;

const utf8 = new TextEncoder();

// UTF-8 takes 1 to 3 bytes per UTF-16 code unit, so only the middle band needs the encode.
export function filterTooLong(text: string): boolean {
  if (text.length > FILTER_MAX_DSL_BYTES) return true;
  return text.length * 3 > FILTER_MAX_DSL_BYTES && utf8.encode(text).length > FILTER_MAX_DSL_BYTES;
}

// The one place that decides what counts as a reserved word: the parser
// rejects it bare, and quoteFilterValue quotes it so a value spelled like
// one still round-trips.
const RESERVED_WORD_RE = /^(AND|OR|NOT)$/i;

// frontend/test/filter-dsl.test.ts asserts `.position` off a caught error —
// it must stay a real own property on the thrown object, not just baked into
// the message string.
class FilterDslError extends Error {
  position: number;
  // `position` is a UTF-8 byte offset (the wire contract); `index` is the same spot as a string index.
  index: number;
  constructor(message: string, position: number, index: number) {
    super(`${message} at position ${position}`);
    this.position = position;
    this.index = index;
  }
}

type SimpleCondition = { column: string; join?: number; op: FilterOp; value?: string | string[]; not?: boolean };

// `aliases` are a join view's table aliases in position order (spec/filter-dsl.md
// §3): qualified columns resolve against them and every condition carries its
// `join`. Without it a qualified column is a parse error.
export function parseFilterDsl(input: string, aliases?: readonly string[]): FilterCondition[] {
  const err = (message: string, index: number): FilterDslError => {
    const position = new TextEncoder().encode(input.slice(0, index)).length;
    return new FilterDslError(message, position, index);
  };
  if (filterTooLong(input)) throw err(`filter too long (max ${FILTER_MAX_DSL_BYTES} bytes)`, 0);

  let pos = 0;
  // Peeks return the full code point (length 2 for astral chars) so
  // surrogate pairs are never split mid-character while advancing.
  const peekAt = (i: number): string | null => {
    if (i >= input.length) return null;
    const cp = input.codePointAt(i);
    return cp === undefined ? null : String.fromCodePoint(cp);
  };
  const peek = (): string | null => peekAt(pos);
  const isWs = (c: string): boolean => /\s/.test(c);
  const skipWsOptional = (): void => {
    let c = peek();
    while (c !== null && isWs(c)) {
      pos += c.length;
      c = peek();
    }
  };
  const skipWsRequired = (): void => {
    const start = pos;
    skipWsOptional();
    if (pos === start) throw err("expected whitespace", start);
  };
  // Case-insensitive with a word-boundary check so LIKELY isn't misread
  // as LIKE; ASCII-only folding so fullwidth/confusable chars never match.
  const matchKeyword = (keyword: string): boolean => {
    for (let i = 0; i < keyword.length; i++) {
      const c = input[pos + i];
      if (c === undefined) return false;
      const folded = c >= "a" && c <= "z" ? String.fromCharCode(c.charCodeAt(0) - 32) : c;
      if (folded !== keyword[i]) return false;
    }
    const next = peekAt(pos + keyword.length);
    return !(next !== null && (next === "_" || /[\p{L}\p{N}]/u.test(next)));
  };
  const consumeKeyword = (keyword: string): boolean => {
    if (!matchKeyword(keyword)) return false;
    pos += keyword.length;
    return true;
  };
  const parseName = (): string => {
    const start = pos;
    const first = peek();
    if (first === null || !/^[a-zA-Z_]$/.test(first)) throw err("expected column name", start);
    pos += 1;
    let c = peek();
    while (c !== null && /^[a-zA-Z0-9_]$/.test(c)) {
      pos += 1;
      c = peek();
    }
    return input.slice(start, pos);
  };
  // A doubled "" decodes to a single literal ".
  const parseQuotedQualifier = (): string => {
    const start = pos;
    pos += 1; // opening quote
    let name = "";
    for (;;) {
      const c = peek();
      if (c === null) throw err("unterminated quoted table alias", start);
      if (c === '"') {
        pos += 1;
        if (peek() === '"') {
          name += '"';
          pos += 1;
        } else break;
      } else {
        name += c;
        pos += c.length;
      }
    }
    if (name === "") throw err("empty table alias", start);
    return name;
  };
  const parseColumn = (): { column: string; join?: number } => {
    const start = pos;
    const quoted = aliases !== undefined && peek() === '"';
    const first = quoted ? parseQuotedQualifier() : parseName();
    if (!quoted && peek() !== ".") return { column: first, ...(aliases ? { join: 0 } : {}) };
    if (!aliases) throw err("qualified column names are only allowed in a join view", start);
    if (peek() !== ".") throw err("expected . after the table alias", pos);
    pos += 1;
    const column = parseName();
    if (peek() === ".") throw err("a column takes one table alias only", pos);
    const join = aliases.indexOf(first);
    if (join < 0) throw err(`unknown table alias ${first}`, start);
    return { column, join };
  };
  // A doubled '' decodes to a single literal '.
  const parseQuotedValue = (): string => {
    const start = pos;
    pos += 1; // opening quote
    let value = "";
    for (;;) {
      const c = peek();
      if (c === null) throw err("unterminated quoted value", start);
      if (c === "'") {
        pos += 1;
        if (peek() === "'") {
          value += "'";
          pos += 1;
        } else break;
      } else {
        value += c;
        pos += c.length;
      }
    }
    return value;
  };
  // AND/OR/NOT are always keywords, never bare values — quote them to use
  // as a literal.
  const parseBareValue = (stop = ""): string => {
    const start = pos;
    let c = peek();
    while (c !== null && !isWs(c) && c !== "'" && !stop.includes(c)) {
      pos += c.length;
      c = peek();
    }
    const value = input.slice(start, pos);
    if (value === "") throw err("expected value", start);
    if (RESERVED_WORD_RE.test(value))
      throw err(`bare ${value} is always a keyword here; quote it to use as a value`, start);
    return value;
  };
  const parseValue = (): string => (peek() === "'" ? parseQuotedValue() : parseBareValue());
  // A bare NULL is rejected where SQL could never match it: x NOT IN (1, NULL)
  // is never true, and neither is x BETWEEN NULL AND 5.
  const parseNonNullValue = (stop: string, nullMessage: string): string => {
    if (peek() === "'") return parseQuotedValue();
    const start = pos;
    const value = parseBareValue(stop);
    if (/^NULL$/i.test(value)) throw err(nullMessage, start);
    return value;
  };
  // A bare list item also stops at , ( and ).
  const parseListItem = (): string => parseNonNullValue(",()", "NULL cannot be in a list; use IS NULL");
  const parseBound = (): string => parseNonNullValue("", "NULL cannot be a BETWEEN bound; use IS NULL");
  const parseList = (): string[] => {
    skipWsOptional();
    if (peek() !== "(") throw err("expected ( to start the list", pos);
    pos += 1;
    skipWsOptional();
    if (peek() === ")") throw err("empty list", pos);
    const items: string[] = [];
    for (;;) {
      items.push(parseListItem());
      skipWsOptional();
      const c = peek();
      if (c === null) throw err("unterminated list", pos);
      pos += 1;
      if (c === ")") return items;
      if (c !== ",") throw err("expected , or )", pos - 1);
      skipWsOptional();
    }
  };
  // Symbolic operators longest-first so >=/<= aren't misread as >/< plus
  // a bare =... value.
  const parseOperator = (): FilterOp => {
    const start = pos;
    if (consumeKeyword("ILIKE")) return "ILIKE";
    if (consumeKeyword("LIKE")) return "LIKE";
    for (const sym of [">=", "<=", "!=", ">", "<", "="] as const) {
      if (input.startsWith(sym, pos)) {
        pos += sym.length;
        return sym;
      }
    }
    throw err("expected operator (one of = != >= <= > < LIKE ILIKE IN BETWEEN, or IS [NOT] NULL)", start);
  };
  // Speculatively tries the word-operator branches (IS [NOT] NULL, [NOT] IN,
  // [NOT] BETWEEN) and rewinds to right after the column if none applies.
  const parseSimpleCondition = (): SimpleCondition => {
    const { column, join } = parseColumn();
    const afterColumn = pos;
    const wsChar = peek();
    if (wsChar !== null && isWs(wsChar)) {
      skipWsOptional();
      if (consumeKeyword("IS")) {
        skipWsRequired();
        const isNot = consumeKeyword("NOT");
        if (isNot) skipWsRequired();
        if (!consumeKeyword("NULL")) throw err("expected NULL", pos);
        return { column, join, op: isNot ? "IS NOT NULL" : "IS NULL" };
      }
      const notStart = pos;
      const negated = consumeKeyword("NOT");
      if (negated) skipWsRequired();
      const wordOp = (): SimpleCondition | null => {
        if (consumeKeyword("IN")) return { column, join, op: "IN", value: parseList() };
        if (!consumeKeyword("BETWEEN")) return null;
        skipWsRequired();
        const lo = parseBound();
        skipWsRequired();
        if (!consumeKeyword("AND")) throw err("expected AND between the BETWEEN bounds", pos);
        skipWsRequired();
        return { column, join, op: "BETWEEN", value: [lo, parseBound()] };
      };
      const simple = wordOp();
      if (simple) return negated ? { ...simple, not: true } : simple;
      if (negated) throw err("NOT here must be followed by IN or BETWEEN", notStart);
      pos = afterColumn;
    }
    skipWsOptional();
    const op = parseOperator();
    skipWsOptional();
    return { column, join, op, value: parseValue() };
  };

  const conditions: FilterCondition[] = [];
  let pendingLogic: "AND" | "OR" | null = null;
  for (;;) {
    let not = false;
    const notStart = pos;
    if (matchKeyword("NOT")) {
      pos += 3;
      skipWsRequired();
      not = true;
    }
    const simple = parseSimpleCondition();
    if (not && simple.not) throw err("double negation", notStart);
    not = not || simple.not === true;
    // Optional wire fields are omitted, never null/false-filled (§5.4.2).
    const condition: FilterCondition = {
      ...(pendingLogic ? { logic: pendingLogic } : {}),
      ...(not ? { not: true } : {}),
      column: simple.column,
      ...(simple.join !== undefined ? { join: simple.join } : {}),
      op: simple.op,
      ...(simple.value !== undefined ? { value: simple.value } : {}),
    };
    conditions.push(condition);
    if (conditions.length > FILTER_MAX_CONDITIONS) throw err(`too many conditions (max ${FILTER_MAX_CONDITIONS})`, pos);
    if (pos >= input.length) break;
    skipWsRequired();
    if (pos >= input.length) break;
    const logicStart = pos;
    if (consumeKeyword("AND")) pendingLogic = "AND";
    else if (consumeKeyword("OR")) pendingLogic = "OR";
    else throw err("expected AND or OR", logicStart);
    skipWsRequired();
  }
  return conditions;
}

// Non-throwing sibling for restore paths (URL-sourced filter) that must
// discard a bad filter silently (ui-guidelines R5) rather than surface it,
// unlike a live submission through submitFilter().
export function tryParseFilterDsl(input: string, aliases?: readonly string[]): FilterCondition[] | null {
  try {
    return parseFilterDsl(input, aliases);
  } catch {
    return null;
  }
}

// ---- click-to-filter: compose "column op value" into #filter and apply ----
// Every cell value is fetched as text, and a typed column's text compares
// equal to its own value, so it can be spliced straight into a clause
// without reshaping.
const quoted = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export function quoteFilterValue(value: string): string {
  if (value !== "" && !/[\s']/.test(value) && !RESERVED_WORD_RE.test(value)) return value;
  return quoted(value);
}

// An IN list item also stops at , ( and ), and a bare NULL is rejected there.
export function quoteListItem(value: string): string {
  return /[,()]/.test(value) || /^NULL$/i.test(value) ? quoted(value) : quoteFilterValue(value);
}

// value is omitted for a valueless predicate (IS NULL). quoteFilterValue
// guarantees the clause parses like a hand-typed one.
export function filterClause(column: string, op: FilterOp, value?: string): string {
  return value === undefined ? `${column} ${op}` : `${column} ${op} ${quoteFilterValue(value)}`;
}

// What an `=` button writes for this value (IS NULL for null), or null when it
// would pass the limit. The click replaces the whole filter, so the clause alone must fit.
export function eqClause(column: string, raw: string | null): string | null {
  if (raw == null) return filterClause(column, "IS NULL");
  if (filterTooLong(raw)) return null;
  const clause = filterClause(column, "=", raw);
  return filterTooLong(clause) ? null : clause;
}

// AND of `column = value`: the composite-key drill-in from referenced-by.
export function filterClauses(pairs: { column: string; value: string }[]): string {
  return pairs.map((p) => filterClause(p.column, "=", p.value)).join(" AND ");
}

// Where parseFilterDsl rejects `input`, as a string index; null when it parses.
export function filterDslErrorAt(
  input: string,
  aliases?: readonly string[],
): { index: number; message: string } | null {
  try {
    parseFilterDsl(input, aliases);
    return null;
  } catch (e) {
    if (!(e instanceof FilterDslError)) return null;
    return { index: e.index, message: e.message };
  }
}
