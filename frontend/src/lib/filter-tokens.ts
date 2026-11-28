// Lenient tokenizer for the filter box: it colours what is typed and says what
// may come next. It never throws and never judges the text — parseFilterDsl
// (spec/filter-dsl.md) alone decides what is accepted.

import type { FilterOp, PathStep } from "../core/types.js";

export type TokenKind = "column" | "arrow" | "key" | "op" | "value" | "keyword" | "space" | "plain";

// What the grammar allows next: a column (after start/AND/OR/NOT), a path key
// (after ->), an operator (after a column or key), the tail of IS [NOT] NULL, IN or BETWEEN after a NOT, an
// IN list's "(", item or "," / ")", a BETWEEN's low bound or its AND, a value,
// AND/OR, or nothing ("error": the text already left the grammar).
export type Expect =
  | "column"
  | "pathKey"
  | "operator"
  | "isTail"
  | "notTail"
  | "listOpen"
  | "listItem"
  | "listNext"
  | "lowBound"
  | "boundAnd"
  | "value"
  | "joiner"
  | "error";

// The states in which the next token is a value.
export function expectsValue(expect: Expect): boolean {
  return expect === "value" || expect === "listItem" || expect === "lowBound";
}

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  // The state this token was read in, so a half-typed last token still knows
  // which kind of word it is trying to be.
  expect: Expect;
  column: string | null;
  // The column's path steps before this token.
  path: PathStep[];
}

export interface Tokenized {
  tokens: Token[];
  expect: Expect;
  column: string | null;
  path: PathStep[];
}

const SYMBOLS = [">=", "<=", "!=", ">", "<", "="];
// A column, optionally qualified by a table alias, each part bare or "quoted". A quote
// still open runs to the end of the text, and a trailing `alias.` with no name yet is
// still one token, so either can be completed while it is typed.
const IDENT =
  /(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")*")\.(?:"(?:[^"]|"")*"?|[A-Za-z0-9_]*)|[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")*"?/y;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
// A path step: a bare key, digits (an index), or a 'quoted' key, closed or not.
const STEP = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|'(?:[^']|'')*'?/y;

// A step's typed text decoded: digits as an index, a quoted key unquoted (closed or not).
export function stepOf(text: string): PathStep {
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (!text.startsWith("'")) return text;
  const closed = /^'(?:[^']|'')*'$/.test(text);
  return text.slice(1, closed ? -1 : undefined).replace(/''/g, "'");
}

// Case-insensitive with the parser's word-boundary rule, so LIKELY is not LIKE.
function keywordAt(text: string, i: number, keyword: string): boolean {
  if (text.slice(i, i + keyword.length).toUpperCase() !== keyword) return false;
  const next = text[i + keyword.length];
  return next === undefined || !WORD_CHAR.test(next);
}

export function tokenizeFilterDsl(text: string): Tokenized {
  const tokens: Token[] = [];
  let expect = "column" as Expect;
  let column: string | null = null;
  let path: PathStep[] = [];
  // A condition that starts with NOT cannot negate its operator too.
  let negated = false;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, next: Expect): void => {
    tokens.push({ kind, start, end, expect, column, path });
    expect = next;
    i = end;
  };
  const isSpace = (c: string): boolean => /\s/.test(c);
  const isListStop = (c: string): boolean => c === "," || c === "(" || c === ")";
  // A path allows no whitespace: an arrow or key counts only right after the column or step.
  const touching = (): boolean => {
    const last = tokens.at(-1);
    return (
      last !== undefined && last.end === i && (last.kind === "column" || last.kind === "key" || last.kind === "arrow")
    );
  };

  while (i < text.length) {
    const s = i;
    if (isSpace(text[i])) {
      let j = i;
      while (j < text.length && isSpace(text[j])) j++;
      tokens.push({ kind: "space", start: s, end: j, expect, column, path });
      i = j;
      continue;
    }
    if (expect === "column") {
      if (keywordAt(text, i, "NOT")) {
        negated = true;
        push("keyword", s, i + 3, "column");
        continue;
      }
      IDENT.lastIndex = i;
      const m = IDENT.exec(text);
      if (m) {
        const name = m[0];
        push("column", s, i + name.length, "operator");
        column = name;
        continue;
      }
    } else if (expect === "pathKey" && touching()) {
      STEP.lastIndex = i;
      const m = STEP.exec(text);
      if (m) {
        push("key", s, i + m[0].length, "operator");
        path = [...path, stepOf(m[0])];
        continue;
      }
    }
    if (expect === "operator" && touching()) {
      const arrow = text.startsWith("->>", i) ? 3 : text.startsWith("->", i) ? 2 : 0;
      if (arrow > 0) {
        push("arrow", s, i + arrow, "pathKey");
        continue;
      }
    }
    if (expect === "operator" || expect === "notTail") {
      if (expect === "operator" && keywordAt(text, i, "IS")) {
        push("keyword", s, i + 2, "isTail");
        continue;
      }
      if (expect === "operator" && !negated && keywordAt(text, i, "NOT")) {
        push("keyword", s, i + 3, "notTail");
        continue;
      }
      if (keywordAt(text, i, "IN")) {
        push("op", s, i + 2, "listOpen");
        continue;
      }
      if (keywordAt(text, i, "BETWEEN")) {
        push("op", s, i + 7, "lowBound");
        continue;
      }
    }
    if (expect === "operator") {
      const word = keywordAt(text, i, "ILIKE") ? "ILIKE" : keywordAt(text, i, "LIKE") ? "LIKE" : null;
      const symbol = SYMBOLS.find((sym) => text.startsWith(sym, i));
      const op = word ?? symbol;
      if (op) {
        push("op", s, i + op.length, "value");
        continue;
      }
    } else if (expect === "isTail") {
      if (keywordAt(text, i, "NOT")) {
        push("keyword", s, i + 3, "isTail");
        continue;
      }
      if (keywordAt(text, i, "NULL")) {
        push("keyword", s, i + 4, "joiner");
        continue;
      }
    } else if (expect === "listOpen" && text[i] === "(") {
      push("op", s, i + 1, "listItem");
      continue;
    } else if (expect === "listNext" && (text[i] === "," || text[i] === ")")) {
      push("op", s, i + 1, text[i] === "," ? "listItem" : "joiner");
      continue;
    } else if (expect === "boundAnd" && keywordAt(text, i, "AND")) {
      push("keyword", s, i + 3, "value");
      continue;
    } else if (expectsValue(expect) && !(expect === "listItem" && isListStop(text[i]))) {
      const inList = expect === "listItem";
      let j = i;
      if (text[i] === "'") {
        j = i + 1;
        while (j < text.length) {
          if (text[j] !== "'") j++;
          else if (text[j + 1] === "'") j += 2;
          else {
            j++;
            break;
          }
        }
      } else {
        while (j < text.length && !isSpace(text[j]) && text[j] !== "'" && !(inList && isListStop(text[j]))) j++;
      }
      push("value", s, j, inList ? "listNext" : expect === "lowBound" ? "boundAnd" : "joiner");
      continue;
    } else if (expect === "joiner") {
      const word = keywordAt(text, i, "AND") ? "AND" : keywordAt(text, i, "OR") ? "OR" : null;
      if (word) {
        push("keyword", s, i + word.length, "column");
        column = null;
        path = [];
        negated = false;
        continue;
      }
    }
    // Not what the grammar allows here: one plain word, and nothing after it
    // is interpreted.
    let j = i;
    while (j < text.length && !isSpace(text[j])) j++;
    push("plain", s, j, "error");
  }
  return { tokens, expect, column, path };
}

export interface Completion {
  expect: Expect;
  // The half-typed word being completed ("" right after whitespace).
  partial: string;
  // Everything before it; a suggestion replaces `partial` and keeps `head`.
  head: string;
  column: string | null;
  path: PathStep[];
}

export function completionAt(text: string): Completion {
  const { tokens, expect, column, path } = tokenizeFilterDsl(text);
  const last = tokens.at(-1);
  // A list's ( or , and a path's arrow are complete on their own, like a space.
  const punct =
    last?.kind === "arrow" || (last?.kind === "op" && (text[last.start] === "(" || text[last.start] === ","));
  if (!last || last.kind === "space" || punct) return { expect, partial: "", head: text, column, path };
  return {
    expect: last.expect,
    partial: text.slice(last.start),
    head: text.slice(0, last.start),
    column: last.column,
    path: last.path,
  };
}

export const FILTER_OPERATORS: readonly FilterOp[] = [
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
];

// The words the grammar accepts next, for the tokens that are keywords.
export function optionsFor(expect: Expect): readonly string[] {
  if (expect === "operator") return [...FILTER_OPERATORS, "NOT IN", "NOT BETWEEN"];
  if (expect === "joiner") return ["AND", "OR"];
  if (expect === "isTail") return ["NULL", "NOT NULL"];
  if (expect === "notTail") return ["IN", "BETWEEN"];
  if (expect === "boundAnd") return ["AND"];
  return [];
}

// True when the text ends in a word that could still grow into one the grammar
// accepts there (`status I`, `a = 1 AN`), so it is unfinished rather than wrong.
export function endsInUnfinishedWord(text: string): boolean {
  const { expect, partial } = completionAt(text);
  if (partial === "") return false;
  const word = partial.toLowerCase();
  return optionsFor(expect).some((o) => o.toLowerCase().startsWith(word));
}
