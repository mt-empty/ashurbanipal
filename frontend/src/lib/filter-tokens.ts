// Lenient tokenizer for the filter box: it colours what is typed and says what
// may come next. It never throws and never judges the text — parseFilterDsl
// (spec/filter-dsl.md) alone decides what is accepted.

import type { FilterOp } from "../core/types.js";

export type TokenKind = "column" | "op" | "value" | "keyword" | "space" | "plain";

// What the grammar allows next: a column (after start/AND/OR/NOT), an operator
// (after a column), the tail of IS [NOT] NULL, IN or BETWEEN after a NOT, an
// IN list's "(", item or "," / ")", a BETWEEN's low bound or its AND, a value,
// AND/OR, or nothing ("error": the text already left the grammar).
export type Expect =
  | "column"
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
}

export interface Tokenized {
  tokens: Token[];
  expect: Expect;
  column: string | null;
}

const SYMBOLS = [">=", "<=", "!=", ">", "<", "="];
// A column, optionally qualified by a table alias (bare or "quoted"). A trailing
// `alias.` with no name yet is still one token, so it can be completed.
const IDENT = /(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")+")\.[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*/y;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

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
  // A condition that starts with NOT cannot negate its operator too.
  let negated = false;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, next: Expect): void => {
    tokens.push({ kind, start, end, expect, column });
    expect = next;
    i = end;
  };
  const isSpace = (c: string): boolean => /\s/.test(c);
  const isListStop = (c: string): boolean => c === "," || c === "(" || c === ")";

  while (i < text.length) {
    const s = i;
    if (isSpace(text[i])) {
      let j = i;
      while (j < text.length && isSpace(text[j])) j++;
      tokens.push({ kind: "space", start: s, end: j, expect, column });
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
    } else if (expect === "operator" || expect === "notTail") {
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
  return { tokens, expect, column };
}

export interface Completion {
  expect: Expect;
  // The half-typed word being completed ("" right after whitespace).
  partial: string;
  // Everything before it; a suggestion replaces `partial` and keeps `head`.
  head: string;
  column: string | null;
}

export function completionAt(text: string): Completion {
  const { tokens, expect, column } = tokenizeFilterDsl(text);
  const last = tokens.at(-1);
  // A list's ( or , is complete on its own, like a space.
  const punct = last?.kind === "op" && (text[last.start] === "(" || text[last.start] === ",");
  if (!last || last.kind === "space" || punct) return { expect, partial: "", head: text, column };
  return {
    expect: last.expect,
    partial: text.slice(last.start),
    head: text.slice(0, last.start),
    column: last.column,
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
