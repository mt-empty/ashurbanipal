import { $ } from "../core/dom.js";
import type { Column } from "../core/types.js";
import { type Draft, draftToDef } from "../lib/join-draft.js";
import { type JoinParse, parseJoin, printJoin, quoteJoinName } from "../lib/join-dsl.js";
import { type JoinCompletion, type JoinToken, joinCompletionAt, tokenizeJoinText } from "../lib/join-tokens.js";
import { findForeignKey, joinMismatch, pairNote } from "../lib/join-types.js";
import {
  cachedColumns,
  catalogVersion,
  indexedColumns,
  knownCatalog,
  readIndexedColumns,
  tableColumns,
} from "./join-catalog.js";
import { attachOverlayHighlight, tokenSpans } from "./overlay-highlight.js";
import { listedTableNames, tableChipCount } from "./sidebar.js";
import { createSuggestList, type Suggestion } from "./suggest-list.js";

// The SQL half of the join overlay (boards U and V): a text field coloured like
// the filter box, with suggestions for what the grammar allows next. The text is
// only ever parsed in the browser (spec/join-dsl.md).

export interface JoinSql {
  setText(text: string): void;
  text(): string;
  // The text parsed against the catalog and column types the page holds.
  parse(): JoinParse;
}

// Form → SQL always works: a finished form prints as canonical text, a
// half-finished one as far as it got.
export function draftText(draft: Draft): string {
  const done = draftToDef(draft);
  if ("def" in done) return printJoin(done.def);
  const ref = (table: string, alias: string): string =>
    alias.trim() ? `${quoteJoinName(table)} ${quoteJoinName(alias.trim())}` : quoteJoinName(table);
  const lines = [`FROM ${draft.table ? ref(draft.table, draft.alias) : ""}`.trimEnd()];
  const nameAt = (pos: number): string => {
    const t = pos === 0 ? { table: draft.table, alias: draft.alias } : draft.joins[pos - 1];
    return quoteJoinName(t.alias.trim() || t.table);
  };
  draft.joins.forEach((j, i) => {
    if (!j.table) return;
    const on = j.on
      .filter((p) => p.leftColumn && p.rightColumn)
      .map(
        (p) =>
          `${nameAt(p.leftJoin)}.${quoteJoinName(p.leftColumn)} = ${nameAt(i + 1)}.${quoteJoinName(p.rightColumn)}`,
      );
    lines.push(
      `${j.type === "left" ? "LEFT" : "INNER"} JOIN ${ref(j.table, j.alias)} ON ${on.join(" AND ")}`.trimEnd(),
    );
  });
  const picked = draft.columns.flatMap((c, pos) =>
    c === null ? [`${nameAt(pos)}.*`] : c.map((col) => `${nameAt(pos)}.${quoteJoinName(col)}`),
  );
  const select =
    draft.columns.some((c) => c !== null) && picked.length > 0 ? `SELECT ${picked.join(", ")}` : "SELECT *";
  return [select, ...lines].join("\n");
}

// What the underline covers: a refused `RIGHT JOIN` through its JOIN, a `WHERE …` to the end of its
// line, an `alias.column` through the column, otherwise the one word.
function errorSpan(text: string, tokens: readonly JoinToken[], index: number, code: string): [number, number] {
  const words = tokens.filter((t) => t.kind !== "space");
  const at = words.findIndex((t) => t.start <= index && index < t.end);
  if (at < 0) return [index, index + 1];
  const [word, next, after] = [words[at], words[at + 1], words[at + 2]];
  const textOf = (t: JoinToken | undefined): string => (t ? text.slice(t.start, t.end) : "");
  if (code === "unsupported-keyword") {
    if (/^(RIGHT|FULL|CROSS|NATURAL)$/i.test(textOf(word)))
      return [index, /^JOIN$/i.test(textOf(next)) ? next.end : word.end];
    const eol = text.indexOf("\n", word.end);
    return [index, eol < 0 ? text.length : eol];
  }
  const qualified =
    textOf(next) === "." &&
    next.start === word.end &&
    after?.start === next.end &&
    (after.kind === "name" || after.kind === "keyword");
  return [index, qualified ? after.end : word.end];
}

// A short alias for a table: its underscore-separated initials, made a bare name the parser accepts
// (not a keyword, ASCII, starting with a letter) and unique among the names in use.
function aliasFor(table: string, taken: ReadonlySet<string>): string {
  const initials = table
    .split("_")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const base = /^[a-z_]/.test(initials) ? initials : `t${initials}`;
  let alias = base;
  for (let n = 2; taken.has(alias) || alias === table || quoteJoinName(alias) !== alias; n++) alias = `${base}${n}`;
  return alias;
}

export function mountJoinSql(onChange: () => void): JoinSql {
  const field = $<HTMLTextAreaElement>("join-sql");
  const hlText = $("join-sql-hl-text");

  // Column types are known for the tables whose columns were read; an unknown pair is allowed.
  const pairCheck = (a: { table: string; column: string }, b: { table: string; column: string }): string | null => {
    const at = cachedColumns(a.table)?.find((c) => c.name === a.column)?.type;
    const bt = cachedColumns(b.table)?.find((c) => c.name === b.column)?.type;
    return at && bt ? (joinMismatch(at, bt)?.message ?? null) : null;
  };
  // Highlight, dialog and suggestions all ask on each keystroke; parse once per text and catalog.
  let memo: { text: string; version: number; result: JoinParse } | null = null;
  const parse = (): JoinParse => {
    const text = field.value;
    const version = catalogVersion();
    if (memo?.text !== text || memo.version !== version)
      memo = { text, version, result: parseJoin(text, { catalog: knownCatalog(), pairCheck }) };
    return memo.result;
  };

  function render(): void {
    const text = field.value;
    // Wrapped lines count too, and the field cannot scroll: grow to the content, never below its rows.
    field.style.height = "";
    if (field.scrollHeight > field.clientHeight) field.style.height = `${field.scrollHeight}px`;
    const result = text.trim() ? parse() : null;
    // An error at the very end is just unfinished typing.
    const error = result && "error" in result && result.error.index < text.trimEnd().length ? result.error : null;
    const tokens = tokenizeJoinText(text);
    const [from, to] = error ? errorSpan(text, tokens, error.index, error.code) : [-1, -1];
    const shown = tokens.map((t) => (t.kind === "punct" ? { ...t, kind: "op" } : t));
    hlText.replaceChildren(...tokenSpans(text, shown, (t) => t.kind !== "space" && t.start >= from && t.start < to));
    // The trailing newline keeps the copy as tall as the field.
    hlText.append("\n");
  }
  attachOverlayHighlight(field, render);

  // Under the line being typed, at the caret's column (the field is monospace).
  const place = (): void => {
    const before = field.value.slice(0, field.selectionStart);
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n") - 1;
    const popup = $("join-sql-suggest");
    popup.style.top = `calc(.6rem + ${line} * 1.375rem)`;
    popup.style.left = `min(calc(.85rem + ${col}ch), calc(100% - ${popup.offsetWidth}px))`;
  };
  const suggest = createSuggestList({
    input: field,
    popup: $("join-sql-suggest"),
    place,
    list: $("join-sql-suggest-list"),
    idPrefix: "join-sql-suggest",
    accept: (suggestion, head) => {
      field.value = `${head}${suggestion.insert}`;
      field.setSelectionRange(field.value.length, field.value.length);
      suggest.close();
      field.focus();
      onChange();
      void update();
    },
  });

  const startsWith = (ctx: JoinCompletion) => {
    const partial = ctx.partial.toLowerCase();
    return (name: string): boolean => name.toLowerCase().startsWith(partial);
  };
  // Re-running after only failures would ask again, forever.
  const anyRead = (results: PromiseSettledResult<unknown>[]): boolean => results.some((r) => r.status === "fulfilled");

  // `name` of a declared table → its table, for `alias.` completion.
  const tableOf = (ctx: JoinCompletion, name: string | null): string | undefined =>
    ctx.declared.find((d) => d.name === name)?.table;

  async function columnRows(ctx: JoinCompletion): Promise<Suggestion[]> {
    const table = tableOf(ctx, ctx.qualifier);
    if (!table) return [];
    const columns = await tableColumns(table);
    // The index tags come from a slower structure request; columns show first and the tags join them once read.
    const indexed = readIndexedColumns(table);
    if (!indexed)
      void indexedColumns(table).then(() => {
        if (document.activeElement === field) void update();
      });
    const otherTable = ctx.otherSide ? tableOf(ctx, ctx.otherSide.qualifier) : undefined;
    const otherType = (cachedColumns(otherTable ?? "") ?? []).find((c) => c.name === ctx.otherSide?.column)?.type;
    const starts = startsWith(ctx);
    return columns
      .filter((c) => starts(c.name))
      .map((c: Column) => {
        const note = pairNote(c.type, otherType);
        return {
          label: c.name,
          insert: `${quoteJoinName(c.name)} `,
          note: note ?? c.type,
          ...(note === null && indexed?.has(c.name) ? { tag: "indexed" } : {}),
          ...(note !== null ? { blocked: true } : {}),
        };
      });
  }

  // A foreign key between a declared table and the one being typed is offered as the whole clause.
  function foreignKeyClause(ctx: JoinCompletion, taken: ReadonlySet<string>, table: string): string | undefined {
    const earlier = ctx.declared.map((d) => ({ table: d.table, columns: cachedColumns(d.table) ?? [] }));
    const fk = findForeignKey(earlier, table, cachedColumns(table) ?? []);
    if (!fk) return undefined;
    const alias = aliasFor(table, taken);
    const left = quoteJoinName(ctx.declared[fk.at].name);
    return `${quoteJoinName(table)} ${alias} ON ${left}.${quoteJoinName(fk.leftColumn)} = ${alias}.${quoteJoinName(fk.rightColumn)}`;
  }

  function tableRows(ctx: JoinCompletion, candidates: string[]): Suggestion[] {
    const used = new Set(ctx.declared.map((d) => d.table));
    const taken = new Set(ctx.declared.map((d) => d.name));
    const withKey: Suggestion[] = [];
    const rest: Suggestion[] = [];
    for (const table of candidates) {
      const clause = used.has(table) ? undefined : foreignKeyClause(ctx, taken, table);
      if (clause) withKey.push({ label: clause, insert: `${clause} `, tag: "foreign key" });
      else
        rest.push({
          label: table,
          insert: `${quoteJoinName(table)} `,
          note: used.has(table) ? "already used · add as alias" : tableChipCount(table),
        });
    }
    return [...withKey, ...rest];
  }

  async function update(): Promise<void> {
    suggest.close();
    const token = suggest.token();
    if (field.selectionStart !== field.value.length) return;
    const ctx = joinCompletionAt(field.value);
    let rows: Suggestion[] = [];
    if (ctx.expect === "table") {
      // Foreign key clauses need the columns of the declared tables and of a few candidates; they appear once read.
      const candidates = listedTableNames().filter(startsWith(ctx));
      const wanted = [...ctx.declared.map((d) => d.table), ...(candidates.length <= 8 ? candidates : [])];
      const missing = [...new Set(wanted)].filter((t) => !cachedColumns(t));
      if (missing.length > 0) {
        void Promise.allSettled(missing.map(tableColumns)).then((results) => {
          if (anyRead(results) && token === suggest.token()) void update();
        });
      }
      rows = tableRows(ctx, candidates);
    } else if (ctx.expect === "qualifier") {
      const starts = startsWith(ctx);
      rows = ctx.declared
        .filter((d) => starts(d.name))
        .map((d) => ({ label: d.name, insert: `${quoteJoinName(d.name)}.`, note: d.name === d.table ? "" : d.table }));
    } else if (ctx.expect === "column") {
      rows = await columnRows(ctx).catch(() => []);
    } else if (ctx.expect === "keyword") {
      rows = ctx.keywords
        .filter((k) => k.startsWith(ctx.partial.toUpperCase()))
        .map((k) => ({ label: k, insert: `${k} ` }));
    }
    if (token !== suggest.token() || document.activeElement !== field || rows.length === 0) return;
    const only =
      rows.length === 1 && !rows[0].blocked && rows[0].insert.trim().toLowerCase() === ctx.partial.toLowerCase();
    if (only) return;
    suggest.show(rows, ctx.head);
  }

  // Column names and types are what catches an unknown column or a mismatched pair; read them for every table the text names.
  function prefetch(): void {
    const listed = new Set(listedTableNames());
    const wanted = [...new Set(joinCompletionAt(field.value).declared.map((d) => d.table))].filter(
      (t) => listed.has(t) && !cachedColumns(t),
    );
    if (wanted.length === 0) return;
    void Promise.allSettled(wanted.map(tableColumns)).then((results) => {
      if (!anyRead(results)) return;
      render();
      onChange();
    });
  }

  field.addEventListener("input", () => {
    prefetch();
    onChange();
    void update();
  });
  field.addEventListener("focus", () => void update());

  return {
    setText(text) {
      field.value = text;
      suggest.close();
    },
    text: () => field.value,
    parse,
  };
}
