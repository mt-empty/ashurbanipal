// Lenient tokenizer for the filter box: it colours what is typed and says what
// may come next. It never throws and never judges the text — parseFilterDsl
// (spec/filter-dsl.md) alone decides what is accepted.

import type { FilterOp } from "../core/types.js";

export type TokenKind = "column" | "op" | "value" | "keyword" | "space" | "plain";

// What the grammar allows next: a column (after start/AND/OR/NOT), an operator
// (after a column), the tail of IS [NOT] NULL, a value, AND/OR, or nothing
// ("error": the text already left the grammar).
export type Expect = "column" | "operator" | "isTail" | "value" | "joiner" | "error";

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
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

// Case-insensitive with the parser's word-boundary rule, so LIKELY is not LIKE.
function keywordAt(text: string, i: number, keyword: string): boolean {
  if (text.slice(i, i + keyword.length).toUpperCase() !== keyword) return false;
  const next = text[i + keyword.length];
  return next === undefined || !WORD_CHAR.test(next);
}

export function tokenizeFilterDsl(text: string): Tokenized {
  const tokens: Token[] = [];
  let expect: Expect = "column";
  let column: string | null = null;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, next: Expect): void => {
    tokens.push({ kind, start, end, expect, column });
    expect = next;
    i = end;
  };
  const isSpace = (c: string): boolean => /\s/.test(c);

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
    } else if (expect === "operator") {
      if (keywordAt(text, i, "IS")) {
        push("keyword", s, i + 2, "isTail");
        continue;
      }
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
    } else if (expect === "value") {
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
        while (j < text.length && !isSpace(text[j]) && text[j] !== "'") j++;
      }
      push("value", s, j, "joiner");
      continue;
    } else if (expect === "joiner") {
      const word = keywordAt(text, i, "AND") ? "AND" : keywordAt(text, i, "OR") ? "OR" : null;
      if (word) {
        push("keyword", s, i + word.length, "column");
        column = null;
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
  if (!last || last.kind === "space") return { expect, partial: "", head: text, column };
  return {
    expect: last.expect,
    partial: text.slice(last.start),
    head: text.slice(0, last.start),
    column: last.column,
  };
}

const FILTER_OPERATORS: readonly FilterOp[] = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "ILIKE",
  "IS NULL",
  "IS NOT NULL",
];

// The words the grammar accepts next, for the tokens that are keywords.
export function optionsFor(expect: Expect): readonly string[] {
  if (expect === "operator") return FILTER_OPERATORS;
  if (expect === "joiner") return ["AND", "OR"];
  if (expect === "isTail") return ["NULL", "NOT NULL"];
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
