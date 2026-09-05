import type { FilterCondition, FilterOp } from "./types.js";

// ==== Filter DSL parser (box text → wire AST) ====
// The single canonical implementation of spec/filter-dsl.md — no backend
// (reference or port) parses DSL text; they all consume the AST this
// emits (spec/protocol.md §5.4.2). Iterative — one flat condition loop,
// no recursive descent — so pathological input can't grow the call stack
// (filter-dsl.md A9). Error positions are UTF-8 byte offsets into the
// input, same convention the DSL-era backend parser reported.
const FILTER_MAX_DSL_BYTES = 1024;
const FILTER_MAX_CONDITIONS = 10;
// The one place that decides what counts as a reserved word: the parser
// rejects it bare, and quoteFilterValue quotes it so a value spelled like
// one still round-trips.
const RESERVED_WORD_RE = /^(AND|OR|NOT)$/i;

// tools/e2e-tests/tests/filter-parser.spec.ts reads `.position` off a
// caught error via page.evaluate — must stay a real own property on the
// thrown object, not just baked into the message.
class FilterDslError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.position = position;
  }
}

type SimpleCondition = { column: string; op: FilterOp; value?: string };

export function parseFilterDsl(input: string): FilterCondition[] {
  const err = (message: string, index: number): FilterDslError => {
    const position = new TextEncoder().encode(input.slice(0, index)).length;
    return new FilterDslError(message, position);
  };
  if (new TextEncoder().encode(input).length > FILTER_MAX_DSL_BYTES)
    throw err(`filter too long (max ${FILTER_MAX_DSL_BYTES} bytes)`, 0);

  let pos = 0;
  // Peeks return the full code point (length 2 for astral chars) so
  // surrogate pairs are never split mid-character while advancing.
  const peekAt = (i: number): string | null => (i < input.length ? String.fromCodePoint(input.codePointAt(i)!) : null);
  const peek = (): string | null => peekAt(pos);
  const isWs = (c: string): boolean => /\s/.test(c);
  const skipWsOptional = (): void => {
    let c: string | null;
    while ((c = peek()) !== null && isWs(c)) pos += c.length;
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
  const parseColumn = (): string => {
    const start = pos;
    const first = peek();
    if (first === null || !/^[a-zA-Z_]$/.test(first)) throw err("expected column name", start);
    pos += 1;
    let c: string | null;
    while ((c = peek()) !== null && /^[a-zA-Z0-9_]$/.test(c)) pos += 1;
    return input.slice(start, pos);
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
        if (peek() === "'") { value += "'"; pos += 1; }
        else break;
      } else { value += c; pos += c.length; }
    }
    return value;
  };
  // AND/OR/NOT are always keywords, never bare values — quote them to use
  // as a literal.
  const parseBareValue = (): string => {
    const start = pos;
    let value = "";
    let c: string | null;
    while ((c = peek()) !== null && !isWs(c) && c !== "'") { value += c; pos += c.length; }
    if (value === "") throw err("expected value", start);
    if (RESERVED_WORD_RE.test(value))
      throw err(`bare ${value} is always a keyword here; quote it to use as a value`, start);
    return value;
  };
  // Symbolic operators longest-first so >=/<= aren't misread as >/< plus
  // a bare =... value.
  const parseOperator = (): FilterOp => {
    const start = pos;
    if (consumeKeyword("ILIKE")) return "ILIKE";
    if (consumeKeyword("LIKE")) return "LIKE";
    for (const sym of [">=", "<=", "!=", ">", "<", "="] as const) {
      if (input.startsWith(sym, pos)) { pos += sym.length; return sym; }
    }
    throw err("expected operator (one of = != >= <= > < LIKE ILIKE, or IS [NOT] NULL)", start);
  };
  // Speculatively tries the IS [NOT] NULL branch and rewinds to right
  // after the column if it doesn't apply.
  const parseSimpleCondition = (): SimpleCondition => {
    const column = parseColumn();
    const afterColumn = pos;
    const wsChar = peek();
    if (wsChar !== null && isWs(wsChar)) {
      skipWsOptional();
      if (consumeKeyword("IS")) {
        skipWsRequired();
        const isNot = consumeKeyword("NOT");
        if (isNot) skipWsRequired();
        if (!consumeKeyword("NULL")) throw err("expected NULL", pos);
        return { column, op: isNot ? "IS NOT NULL" : "IS NULL" };
      }
      pos = afterColumn;
    }
    skipWsOptional();
    const op = parseOperator();
    skipWsOptional();
    const value = peek() === "'" ? parseQuotedValue() : parseBareValue();
    return { column, op, value };
  };

  const conditions: FilterCondition[] = [];
  let pendingLogic: "AND" | "OR" | null = null;
  for (;;) {
    let not = false;
    if (matchKeyword("NOT")) { pos += 3; skipWsRequired(); not = true; }
    const simple = parseSimpleCondition();
    // Optional wire fields are omitted, never null/false-filled (§5.4.2).
    const condition: FilterCondition = {
      ...(pendingLogic ? { logic: pendingLogic } : {}),
      ...(not ? { not: true } : {}),
      column: simple.column,
      op: simple.op,
      ...(simple.value !== undefined ? { value: simple.value } : {}),
    };
    conditions.push(condition);
    if (conditions.length > FILTER_MAX_CONDITIONS)
      throw err(`too many conditions (max ${FILTER_MAX_CONDITIONS})`, pos);
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
export function tryParseFilterDsl(input: string): FilterCondition[] | null {
  try { return parseFilterDsl(input); } catch { return null; }
}

// ---- click-to-filter: compose "column op value" into #filter and apply ----
// Every cell value is fetched with an explicit ::text cast, which is
// exactly what the filter DSL compares against, so it can be spliced
// straight into a clause without reshaping.
export function quoteFilterValue(value: string): string {
  if (value !== "" && !/[\s']/.test(value) && !RESERVED_WORD_RE.test(value)) return value;
  return "'" + value.replace(/'/g, "''") + "'";
}

// Test hook: tools/e2e-tests/tests/filter-parser.spec.ts drives the parser
// fixture table (and the quoteFilterValue→parser round-trip) via
// page.evaluate — module scope is otherwise unreachable from outside, and
// this one namespaced global is the entire exposed surface.
declare global {
  interface Window {
    __ashurbanipal: { parseFilterDsl: typeof parseFilterDsl; quoteFilterValue: typeof quoteFilterValue };
  }
}
window.__ashurbanipal = { parseFilterDsl, quoteFilterValue };
