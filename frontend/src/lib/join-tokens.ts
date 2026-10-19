// Lenient tokenizer for the join text field: it colours what is typed and says
// what may come next. It never throws and never judges the text — parseJoin
// (spec/join-dsl.md) alone decides what is accepted.

export type JoinTokenKind = "keyword" | "name" | "punct" | "space" | "plain";

export interface JoinToken {
  kind: JoinTokenKind;
  start: number;
  end: number;
}

// The words of join-dsl.ts's JOIN_KEYWORDS and JOIN_REJECTED_KEYWORDS (a unit
// test keeps the lists equal); this module has no runtime imports.
const KEYWORDS = new Set(["SELECT", "FROM", "JOIN", "INNER", "LEFT", "OUTER", "ON", "AND", "AS"]);
const REJECTED = new Set([
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "USING",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "DISTINCT",
  "OR",
]);
export const JOIN_TOKEN_WORDS = { keywords: KEYWORDS, rejected: REJECTED };

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

export function tokenizeJoinText(text: string): JoinToken[] {
  const tokens: JoinToken[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const c = text[i];
    if (/\s/.test(c)) {
      while (i < text.length && /\s/.test(text[i])) i++;
      tokens.push({ kind: "space", start, end: i });
    } else if (c === '"') {
      i++;
      for (; i < text.length; i++) {
        if (text[i] !== '"') continue;
        if (text[i + 1] === '"') i++;
        else {
          i++;
          break;
        }
      }
      tokens.push({ kind: "name", start, end: i });
    } else if (/[A-Za-z_]/.test(c)) {
      WORD.lastIndex = i;
      i = start + (WORD.exec(text)?.[0].length ?? 1);
      const upper = text.slice(start, i).toUpperCase();
      tokens.push({ kind: KEYWORDS.has(upper) ? "keyword" : REJECTED.has(upper) ? "plain" : "name", start, end: i });
    } else {
      i++;
      tokens.push({ kind: ".,;*=".includes(c) ? "punct" : "plain", start, end: i });
    }
  }
  return tokens;
}

export type JoinExpect = "table" | "qualifier" | "column" | "keyword" | "none";

export interface DeclaredTable {
  // What a colref names it by: the alias, or the table when unaliased.
  name: string;
  table: string;
}

export interface JoinCompletion {
  expect: JoinExpect;
  // The half-typed word being completed ("" right after whitespace or a dot).
  partial: string;
  // Everything before it; a suggestion replaces `partial` and keeps `head`.
  head: string;
  // The alias before the dot, when completing a column.
  qualifier: string | null;
  declared: DeclaredTable[];
  // The colref on the other side of `=`, when completing the second one.
  otherSide: { qualifier: string; column: string } | null;
  keywords: readonly string[];
}

const unquote = (s: string): string =>
  s.startsWith('"') ? s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined).replaceAll('""', '"') : s;

// Reads the text up to its end the way the parser would, then says what fits next.
export function joinCompletionAt(text: string): JoinCompletion {
  const all = tokenizeJoinText(text);
  const last = all.at(-1);
  // The word or dotted word being typed is not part of the context before it.
  let cut = all.length;
  let qualifier: string | null = null;
  let partial = "";
  const sig = all.filter((t) => t.kind !== "space");
  const end = sig.at(-1);
  if (last && last.kind !== "space" && end) {
    const prev = sig.at(-2);
    const prev2 = sig.at(-3);
    if (end.kind === "punct" && text[end.start] === "." && prev && prev.kind === "name") {
      qualifier = unquote(text.slice(prev.start, prev.end));
      cut = all.indexOf(prev);
    } else if (
      end.kind === "name" &&
      prev &&
      prev.kind === "punct" &&
      text[prev.start] === "." &&
      prev2 &&
      prev2.kind === "name"
    ) {
      qualifier = unquote(text.slice(prev2.start, prev2.end));
      partial = text.slice(end.start, end.end);
      cut = all.indexOf(prev2);
    } else if (end.kind === "name" || end.kind === "keyword") {
      partial = text.slice(end.start, end.end);
      cut = all.indexOf(end);
    }
  }
  const head = text.slice(0, text.length - partial.length);
  const declared: DeclaredTable[] = [];
  type State = "start" | "table" | "after-table" | "alias" | "colref" | "after-colref" | "select";
  let state: State = "start";
  let from = false; // the current table clause is FROM, not JOIN
  let table = "";
  let pending: DeclaredTable | null = null;
  let afterEq = false;
  let refs: { qualifier: string; column: string }[] = [];
  const flush = (): void => {
    if (pending) declared.push(pending);
    pending = null;
  };
  const before = all.slice(0, cut).filter((t) => t.kind !== "space");
  for (let k = 0; k < before.length; k++) {
    const t = before[k];
    const w = text.slice(t.start, t.end);
    const upper = w.toUpperCase();
    if (t.kind === "keyword") {
      if (upper === "FROM" || upper === "JOIN") {
        flush();
        state = "table";
        from = upper === "FROM";
      } else if (upper === "ON" || upper === "AND") {
        flush();
        state = "colref";
        afterEq = false;
        refs = [];
      } else if (upper === "AS") state = "alias";
      else if (upper === "SELECT") state = "select";
      else if (state !== "start") flush();
    } else if (t.kind === "name" && state === "table") {
      table = unquote(w);
      pending = { name: table, table };
      state = "after-table";
    } else if (t.kind === "name" && (state === "after-table" || state === "alias")) {
      if (pending) pending.name = unquote(w);
      state = "after-table";
    } else if (t.kind === "name" && state === "colref") {
      const dot = before[k + 1];
      const col = before[k + 2];
      if (dot && text[dot.start] === "." && col?.kind === "name") {
        refs.push({ qualifier: unquote(w), column: unquote(text.slice(col.start, col.end)) });
        k += 2;
        state = "after-colref";
      }
    } else if (t.kind === "punct" && w === "=" && state === "after-colref") {
      state = "colref";
      afterEq = true;
    }
  }
  flush();
  const joinWords = ["JOIN", "INNER JOIN", "LEFT JOIN"];
  let expect: JoinExpect = "none";
  let keywords: readonly string[] = [];
  if (qualifier !== null) expect = state === "colref" ? "column" : "none";
  else if (state === "table") expect = "table";
  else if (state === "colref") expect = "qualifier";
  else if (state === "after-table" && partial !== "") {
    expect = "keyword";
    keywords = from ? joinWords : ["ON"];
  } else if (state === "after-colref" && partial !== "") {
    expect = "keyword";
    keywords = ["AND", ...joinWords];
  }
  return {
    expect,
    partial,
    head,
    qualifier,
    declared,
    otherSide: afterEq && refs.length > 0 ? (refs.at(-1) ?? null) : null,
    keywords,
  };
}
