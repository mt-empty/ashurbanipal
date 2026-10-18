import type { JoinClause, JoinColumn, JoinDef, JoinPair, JoinTable } from "../core/types.js";

// ==== Join DSL parser (join text → JoinDef) ====
// The text never reaches the server, only the JoinDef built from it. One flat
// clause loop, so input cannot grow the call stack (spec/join-dsl.md A7).

// spec/protocol.md §5.11.1.
export const JOIN_MAX_TABLES = 4;
export const JOIN_MAX_PAIRS = 3;
// The byte bound on the wire `join` text (spec/protocol.md §5.11.1).
export const JOIN_MAX_BYTES = 8192;

// Words a bare name may not be; printJoin quotes a name spelled like one.
export const JOIN_KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT",
  "FROM",
  "JOIN",
  "INNER",
  "LEFT",
  "OUTER",
  "ON",
  "AND",
  "AS",
]);
// Valid SQL the grammar refuses; the parser names the part instead of calling it a typo.
export const JOIN_REJECTED_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedWord(word: string): boolean {
  const upper = word.toUpperCase();
  return JOIN_KEYWORDS.has(upper) || JOIN_REJECTED_KEYWORDS.has(upper) || upper === "OR";
}

export function quoteJoinName(name: string): string {
  return BARE_NAME.test(name) && !isReservedWord(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

// What a colref qualifier resolves against: the alias, or the table name when unaliased.
export function effectiveName(t: JoinTable): string {
  return t.alias ?? t.table;
}

export function printJoin(def: JoinDef): string {
  const name = (i: number): string => quoteJoinName(effectiveName(def.tables[i]));
  const ref = (i: number): string => {
    const t = def.tables[i];
    return t.alias === null ? quoteJoinName(t.table) : `${quoteJoinName(t.table)} ${quoteJoinName(t.alias)}`;
  };
  const select =
    def.columns === null
      ? "*"
      : def.columns.map((c) => `${name(c.join)}.${"all" in c ? "*" : quoteJoinName(c.column)}`).join(", ");
  const lines = [`SELECT ${select}`, `FROM ${ref(0)}`];
  def.joins.forEach((j, i) => {
    const on = j.on
      .map((p) => `${name(p.left.join)}.${quoteJoinName(p.left.column)} = ${name(i + 1)}.${quoteJoinName(p.right)}`)
      .join(" AND ");
    lines.push(`${j.type === "left" ? "LEFT" : "INNER"} JOIN ${ref(i + 1)} ON ${on}`);
  });
  return lines.join("\n");
}

export type JoinErrorCode =
  | "empty"
  | "expected"
  | "unsupported-keyword"
  | "unsupported-syntax"
  | "multiple-statements"
  | "no-join"
  | "bad-pair"
  | "duplicate-name"
  | "unknown-alias"
  | "unknown-table"
  | "unknown-column"
  | "too-many-tables"
  | "too-many-pairs"
  | "bad-select"
  | "bad-identifier"
  | "type-mismatch";

export interface JoinError {
  code: JoinErrorCode;
  message: string;
  // String index into the text, and the same spot as 1-based line and column.
  index: number;
  line: number;
  column: number;
  // The closest catalog name, when the message offers one.
  suggest?: string;
}

export type JoinParse = { def: JoinDef } | { error: JoinError };

export interface JoinParseOptions {
  catalog?: JoinCatalog;
  // Says why two columns cannot be paired (their types), or null. Only the page
  // knows the types, so the parser never checks them unless it is given this.
  pairCheck?: (a: { table: string; column: string }, b: { table: string; column: string }) => string | null;
}

// Table name → its column names, or null when only the table is known. Names
// the catalog lacks are rejected; a null column list skips the column check.
export type JoinCatalog = Readonly<Record<string, readonly string[] | null>>;

type Tok =
  | { kind: "word" | "quoted"; text: string; start: number; end: number }
  | { kind: "sym" | "op"; text: string; start: number; end: number }
  | { kind: "end"; text: ""; start: number; end: number };

const OPERATOR_WORDS = new Set(["OR", "LIKE", "ILIKE", "IN", "IS", "NOT", "BETWEEN"]);

const REJECTED_MESSAGE: Record<string, string> = {
  RIGHT: "RIGHT joins are not supported. Use LEFT or INNER.",
  FULL: "FULL joins are not supported. Use LEFT or INNER.",
  CROSS: "CROSS joins are not supported. Use LEFT or INNER.",
  NATURAL: "NATURAL joins are not supported. Write the ON pairs.",
  USING: "USING is not supported. Write ON a.x = b.y.",
  WHERE: "WHERE is not part of the join. Filter with the bar above the grid.",
  ORDER: "ORDER BY is not part of the join. Click a column header to sort.",
};

class JoinFailure extends Error {
  error: JoinError;
  constructor(error: JoinError) {
    super(error.message);
    this.error = error;
  }
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

export function parseJoin(text: string, options: JoinParseOptions = {}): JoinParse {
  const catalog = options.catalog;
  let pos = 0;
  let cur: Tok | null = null;

  const fail = (code: JoinErrorCode, message: string, index: number, suggest?: string): never => {
    const before = text.slice(0, index).split("\n");
    throw new JoinFailure({
      code,
      message,
      index,
      line: before.length,
      column: before[before.length - 1].length + 1,
      ...(suggest !== undefined ? { suggest } : {}),
    });
  };

  const lex = (): Tok => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    const start = pos;
    if (start >= text.length) return { kind: "end", text: "", start: text.length, end: text.length };
    const c = text[start];
    if ((c === "-" && text[start + 1] === "-") || (c === "/" && text[start + 1] === "*"))
      return fail("unsupported-syntax", "comments are not supported", start);
    if (c === '"') {
      let name = "";
      let i = start + 1;
      for (;;) {
        if (i >= text.length) return fail("bad-identifier", "unterminated quoted name", start);
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            name += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += text[i++];
      }
      if (name === "") return fail("bad-identifier", "a quoted name cannot be empty", start);
      return { kind: "quoted", text: name, start, end: i };
    }
    if (/[A-Za-z_]/.test(c)) {
      let i = start + 1;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
      return { kind: "word", text: text.slice(start, i), start, end: i };
    }
    if (".,;*()=".includes(c) && !(c === "=" && /[<>!=]/.test(text[start + 1] ?? "")))
      return { kind: "sym", text: c, start, end: start + 1 };
    if (/[<>!=]/.test(c)) {
      let i = start + 1;
      while (i < text.length && /[<>!=]/.test(text[i])) i++;
      return { kind: "op", text: text.slice(start, i), start, end: i };
    }
    return fail("bad-identifier", `unexpected character ${JSON.stringify(c)}`, start);
  };

  const peek = (): Tok => {
    cur ??= lex();
    return cur;
  };
  const next = (): Tok => {
    const t = peek();
    cur = null;
    pos = t.end;
    return t;
  };
  const isWord = (t: Tok, word: string): boolean => t.kind === "word" && t.text.toUpperCase() === word;
  const isSym = (t: Tok, sym: string): boolean => t.kind === "sym" && t.text === sym;
  const isNameTok = (t: Tok): boolean => t.kind === "quoted" || (t.kind === "word" && !isReservedWord(t.text));

  // Names the part that is wrong: a refused word or symbol says so, anything
  // else says what was expected instead.
  const unexpected = (t: Tok, wanted: string): never => {
    if (t.kind === "word") {
      const upper = t.text.toUpperCase();
      if (JOIN_REJECTED_KEYWORDS.has(upper))
        return fail("unsupported-keyword", REJECTED_MESSAGE[upper] ?? `${upper} is not supported`, t.start);
      if (OPERATOR_WORDS.has(upper))
        return fail("unsupported-syntax", `${upper} is not supported; ON takes = pairs joined by AND`, t.start);
    }
    if (isSym(t, "(") || isSym(t, ")"))
      return fail("unsupported-syntax", "parentheses, function calls and subqueries are not supported", t.start);
    if (t.kind === "op") return fail("unsupported-syntax", `${t.text} is not supported; only = is`, t.start);
    return fail(
      "expected",
      `expected ${wanted} but found ${t.kind === "end" ? "end of text" : `"${t.text}"`}`,
      t.start,
    );
  };

  const expectWord = (word: string): void => {
    const t = peek();
    if (!isWord(t, word)) unexpected(t, word);
    next();
  };
  const nameTok = (wanted: string): Tok => {
    const t = peek();
    if (!isNameTok(t)) unexpected(t, wanted);
    return next();
  };

  const tables: JoinTable[] = [];
  const names = new Map<string, number>();

  const tableref = (): void => {
    const t = nameTok("a table name");
    if (catalog && !Object.hasOwn(catalog, t.text)) {
      const suggest = closest(t.text, Object.keys(catalog));
      fail(
        "unknown-table",
        `There is no table ${t.text}.${suggest ? ` Did you mean ${suggest}?` : ""}`,
        t.start,
        suggest,
      );
    }
    let alias: string | null = null;
    if (isWord(peek(), "AS")) {
      next();
      alias = nameTok("an alias after AS").text;
    } else if (isNameTok(peek())) alias = next().text;
    const table: JoinTable = { table: t.text, alias };
    const name = effectiveName(table);
    if (names.has(name))
      fail(
        "duplicate-name",
        alias === null && tables.some((x) => x.table === t.text)
          ? `table "${t.text}" appears twice; give the second use an alias`
          : `the name "${name}" is used twice; each table needs its own alias`,
        t.start,
      );
    names.set(name, tables.length);
    tables.push(table);
  };

  interface ColRef {
    qual: string;
    qualStart: number;
    column: string;
    columnStart: number;
  }
  const colref = (): ColRef => {
    const q = nameTok("a column written as alias.column");
    const dot = peek();
    if (!isSym(dot, ".")) {
      if (isSym(dot, "(")) unexpected(dot, "");
      return fail("bad-pair", `write ${q.text} as alias.column`, q.start);
    }
    next();
    const c = nameTok("a column name");
    return { qual: q.text, qualStart: q.start, column: c.text, columnStart: c.start };
  };

  const columnsOf = (table: string): readonly string[] | null => (catalog ? (catalog[table] ?? null) : null);
  const checkColumn = (position: number, c: ColRef): void => {
    const known = columnsOf(tables[position].table);
    if (known === null || known.includes(c.column)) return;
    const suggest = closest(c.column, known);
    fail(
      "unknown-column",
      `${tables[position].table} has no column ${c.column}.${suggest ? ` Did you mean ${suggest}?` : ""}`,
      c.columnStart,
      suggest,
    );
  };
  const resolve = (c: ColRef): number => {
    const position = names.get(c.qual);
    if (position === undefined)
      return fail("unknown-alias", `no table or alias named "${c.qual}" in this join`, c.qualStart);
    return position;
  };

  const pair = (newPosition: number): JoinPair => {
    const first = colref();
    const op = peek();
    if (!isSym(op, "=")) unexpected(op, '"="');
    next();
    const second = colref();
    const a = resolve(first);
    const b = resolve(second);
    const forward = b === newPosition && a < newPosition;
    if (!forward && !(a === newPosition && b < newPosition))
      fail(
        "bad-pair",
        `each ON pair needs one column of "${effectiveName(tables[newPosition])}" and one of an earlier table`,
        first.qualStart,
      );
    checkColumn(a, first);
    checkColumn(b, second);
    const clash = options.pairCheck?.(
      { table: tables[a].table, column: first.column },
      { table: tables[b].table, column: second.column },
    );
    if (clash) fail("type-mismatch", clash, second.qualStart);
    return forward
      ? { left: { join: a, column: first.column }, right: second.column }
      : { left: { join: b, column: second.column }, right: first.column };
  };

  interface SelItem extends ColRef {
    all: boolean;
  }

  const run = (): JoinDef => {
    if (peek().kind === "end")
      fail("empty", "enter a join, for example: FROM orders JOIN users ON orders.user_id = users.id", 0);

    let items: SelItem[] | null = null;
    if (isWord(peek(), "SELECT")) {
      next();
      const star = peek();
      if (isSym(star, "*")) {
        next();
        if (isSym(peek(), ",")) fail("bad-select", "use * alone, or a list of alias.column items", star.start);
      } else {
        items = [];
        for (;;) {
          const q = nameTok("a column written as alias.column");
          const dot = peek();
          if (!isSym(dot, ".")) {
            if (isSym(dot, "(")) unexpected(dot, "");
            fail("bad-select", `write ${q.text} as alias.column`, q.start);
          }
          next();
          const c = peek();
          if (isSym(c, "*")) {
            next();
            items.push({ qual: q.text, qualStart: q.start, column: "*", columnStart: c.start, all: true });
          } else {
            const col = nameTok("a column name or *");
            items.push({ qual: q.text, qualStart: q.start, column: col.text, columnStart: col.start, all: false });
          }
          if (!isSym(peek(), ",")) break;
          next();
        }
      }
    }
    expectWord("FROM");
    tableref();

    const joins: JoinClause[] = [];
    for (;;) {
      const t = peek();
      if (t.kind === "end" || isSym(t, ";")) break;
      let type: JoinClause["type"] = "inner";
      if (isWord(t, "INNER")) {
        next();
        expectWord("JOIN");
      } else if (isWord(t, "LEFT")) {
        type = "left";
        next();
        if (isWord(peek(), "OUTER")) next();
        expectWord("JOIN");
      } else if (isWord(t, "JOIN")) next();
      else unexpected(t, 'JOIN, ";" or end of text');
      if (tables.length >= JOIN_MAX_TABLES)
        fail("too-many-tables", `a join takes at most ${JOIN_MAX_TABLES} tables`, t.start);
      tableref();
      expectWord("ON");
      const on: JoinPair[] = [];
      for (;;) {
        on.push(pair(tables.length - 1));
        const and = peek();
        if (!isWord(and, "AND")) break;
        if (on.length >= JOIN_MAX_PAIRS)
          fail("too-many-pairs", `an ON takes at most ${JOIN_MAX_PAIRS} pairs`, and.start);
        next();
      }
      joins.push({ type, on });
    }
    if (isSym(peek(), ";")) {
      next();
      const rest = peek();
      if (rest.kind !== "end") fail("multiple-statements", "only one statement is allowed", rest.start);
    }
    if (joins.length === 0) fail("no-join", "add at least one JOIN", text.length);

    let columns: JoinColumn[] | null = null;
    if (items) {
      columns = [];
      const whole = new Set<number>();
      const single = new Set<string>();
      for (const item of items) {
        const position = resolve(item);
        const duplicate = item.all
          ? whole.has(position) || [...single].some((k) => k.startsWith(`${position}\0`))
          : whole.has(position) || single.has(`${position}\0${item.column}`);
        if (duplicate) fail("bad-select", `${item.qual}.${item.column} is selected twice`, item.qualStart);
        if (item.all) {
          whole.add(position);
          columns.push({ join: position, all: true });
        } else {
          checkColumn(position, item);
          single.add(`${position}\0${item.column}`);
          columns.push({ join: position, column: item.column });
        }
      }
    }
    return { tables, joins, columns };
  };

  try {
    return { def: run() };
  } catch (e) {
    if (e instanceof JoinFailure) return { error: e.error };
    throw e;
  }
}
