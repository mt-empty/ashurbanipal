import type { FilterCondition, FilterOp, PathStep } from "../core/types.js";

// ==== Filter DSL parser (box text → wire AST) ====
// The single canonical implementation of spec/filter-dsl.md — no backend
// (reference or port) parses DSL text; they all consume the AST this
// emits (spec/protocol.md §5.4.2). Iterative — one flat condition loop,
// no recursive descent — so pathological input can't grow the call stack
// (filter-dsl.md A9). Error positions are UTF-8 byte offsets into the
// input, same convention the DSL-era backend parser reported.
const FILTER_MAX_DSL_BYTES = 1024;
const FILTER_MAX_CONDITIONS = 10;
// spec/protocol.md §5.4.2: the server refuses anything past these, so the parser does too.
const PATH_MAX_STEPS = 8;
const PATH_MAX_KEY_BYTES = 255;
const PATH_MAX_INDEX = 2 ** 31 - 1;

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

type ColumnRef = { column: string; join?: number; path?: PathStep[] };
type SimpleCondition = ColumnRef & { op: FilterOp; value?: string | string[]; not?: boolean };

// Why a key cannot go in a path (spec/protocol.md §5.4.2 refuses it), or null when it can.
function badPathKey(key: string): string | null {
  if (key === "") return "a key can't be empty";
  if (/["\\]/.test(key)) return "a key can't contain \" or \\";
  for (const c of key) if (c < " ") return "a key can't contain a control character";
  if (utf8.encode(key).length > PATH_MAX_KEY_BYTES) return `a key is at most ${PATH_MAX_KEY_BYTES} bytes`;
  return null;
}

// The arrow at `i` (`->>` before `->`, so `a->>b` is one arrow), as its length; 0 if none.
function arrowAt(text: string, i: number): number {
  if (text.startsWith("->>", i)) return 3;
  return text.startsWith("->", i) ? 2 : 0;
}

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
  const parseColumnName = (): ColumnRef => {
    const start = pos;
    const quoted = aliases !== undefined && peek() === '"';
    const first = quoted ? parseQuotedQualifier() : parseName();
    if (!quoted && peek() !== ".") return { column: first, ...(aliases ? { join: 0 } : {}) };
    if (!aliases) throw err("qualified column names are only allowed in a join view; a JSON key takes ->", start);
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
  const parsePathStep = (): PathStep => {
    const start = pos;
    const c = peek();
    if (c === "'") {
      const key = parseQuotedValue();
      const bad = badPathKey(key);
      if (bad) throw err(bad, start);
      return key;
    }
    if (c !== null && c >= "0" && c <= "9") {
      while (/^[0-9]$/.test(peek() ?? "")) pos += 1;
      const index = Number(input.slice(start, pos));
      if (index > PATH_MAX_INDEX) throw err(`an index is at most ${PATH_MAX_INDEX}`, start);
      return index;
    }
    if (c === null || !/^[a-zA-Z_]$/.test(c)) throw err("expected a key or an index after ->", start);
    return parseName();
  };
  // `before` is the column and path up to the misplaced spaces; the hint names the step after them.
  const spacesError = (before: string, at: number, stepAt: number): FilterDslError => {
    const step = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|'(?:[^']|'')*')/.exec(input.slice(stepAt));
    return err(`remove the spaces around ->${step ? `: write ${before}->${step[0]}` : ""}`, at);
  };
  // A column with its path; no whitespace inside, the same rule as the alias dot.
  const parseColumn = (): ColumnRef => {
    const columnStart = pos;
    const ref = parseColumnName();
    const path: PathStep[] = [];
    for (;;) {
      const arrowStart = pos;
      const arrow = arrowAt(input, pos);
      if (arrow === 0) {
        skipWsOptional();
        const spaced = pos > arrowStart ? arrowAt(input, pos) : 0;
        if (spaced > 0) {
          const at = pos;
          pos += spaced;
          skipWsOptional();
          throw spacesError(input.slice(columnStart, arrowStart), at, pos);
        }
        pos = arrowStart;
        if (peek() === "[" || input.startsWith("#>", pos)) throw err("write a JSON path with ->", pos);
        break;
      }
      pos += arrow;
      skipWsOptional();
      if (pos > arrowStart + arrow) throw spacesError(input.slice(columnStart, arrowStart), pos, pos);
      if (path.length === PATH_MAX_STEPS) throw err(`a path has at most ${PATH_MAX_STEPS} steps`, pos);
      path.push(parsePathStep());
    }
    return path.length > 0 ? { ...ref, path } : ref;
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
    const ref = parseColumn();
    const afterColumn = pos;
    const wsChar = peek();
    if (wsChar !== null && isWs(wsChar)) {
      skipWsOptional();
      if (consumeKeyword("IS")) {
        skipWsRequired();
        const isNot = consumeKeyword("NOT");
        if (isNot) skipWsRequired();
        if (!consumeKeyword("NULL")) throw err("expected NULL", pos);
        return { ...ref, op: isNot ? "IS NOT NULL" : "IS NULL" };
      }
      const notStart = pos;
      const negated = consumeKeyword("NOT");
      if (negated) skipWsRequired();
      const wordOp = (): SimpleCondition | null => {
        if (consumeKeyword("IN")) return { ...ref, op: "IN", value: parseList() };
        if (!consumeKeyword("BETWEEN")) return null;
        skipWsRequired();
        const lo = parseBound();
        skipWsRequired();
        if (!consumeKeyword("AND")) throw err("expected AND between the BETWEEN bounds", pos);
        skipWsRequired();
        return { ...ref, op: "BETWEEN", value: [lo, parseBound()] };
      };
      const simple = wordOp();
      if (simple) return negated ? { ...simple, not: true } : simple;
      if (negated) throw err("NOT here must be followed by IN or BETWEEN", notStart);
      pos = afterColumn;
    }
    skipWsOptional();
    const op = parseOperator();
    skipWsOptional();
    return { ...ref, op, value: parseValue() };
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
      ...(simple.path ? { path: simple.path } : {}),
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

// NULL is quoted too: a list item or a BETWEEN bound refuses it bare, and quoted it means the same string everywhere.
export function quoteFilterValue(value: string): string {
  if (value !== "" && !/[\s']/.test(value) && !RESERVED_WORD_RE.test(value) && !/^NULL$/i.test(value)) return value;
  return quoted(value);
}

// An IN list item also stops at , ( and ).
export function quoteListItem(value: string): string {
  return /[,()]/.test(value) ? quoted(value) : quoteFilterValue(value);
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

// A column with its path as the box writes it: a bare name, digits for an
// index, else a quoted key. Null when a key can't be written or the path is too deep.
export function pathText(column: string, path: readonly PathStep[]): string | null {
  if (path.length > PATH_MAX_STEPS) return null;
  let text = column;
  for (const step of path) {
    const written = pathStepText(step);
    if (written === null) return null;
    text += `->${written}`;
  }
  return text;
}

// One path step as the box writes it, or null for a key it can't hold.
export function pathStepText(step: PathStep): string | null {
  if (typeof step === "number") return String(step);
  if (badPathKey(step)) return null;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(step) ? step : quoted(step);
}

// eqClause for a value inside a JSON column.
export function pathEqClause(column: string, path: readonly PathStep[], raw: string | null): string | null {
  const lhs = pathText(column, path);
  return lhs === null ? null : eqClause(lhs, raw);
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
