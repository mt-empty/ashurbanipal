import { $ } from "../core/dom.js";
import type { Column } from "../core/types.js";
import type { Draft } from "../lib/join-draft.js";
import { type JoinParse, parseJoin, quoteJoinName } from "../lib/join-dsl.js";
import { type JoinCompletion, joinCompletionAt, tokenizeJoinText } from "../lib/join-tokens.js";
import { joinMismatch, unjoinableReason } from "../lib/join-types.js";
import { cachedColumns, indexedColumns, knownCatalog, tableColumns } from "./join-catalog.js";
import { attachOverlayHighlight } from "./overlay-highlight.js";
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

// Form → SQL always works: a half-finished form prints as far as it got.
export function draftText(draft: Draft): string {
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
function errorSpan(text: string, index: number, code: string): [number, number] {
  const word =
    /^(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(index))?.[0] ?? text.slice(index, index + 1);
  let end = index + word.length;
  if (code === "unsupported-keyword") {
    if (/^(RIGHT|FULL|CROSS|NATURAL)$/i.test(word)) end += /^\s+JOIN\b/i.exec(text.slice(end))?.[0].length ?? 0;
    else end = text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end);
  } else {
    end += /^\.(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(end))?.[0].length ?? 0;
  }
  return [index, end];
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
  const parse = (): JoinParse => parseJoin(field.value, { catalog: knownCatalog(), pairCheck });

  function render(): void {
    const text = field.value;
    field.rows = Math.max(5, text.split("\n").length + 1);
    const result = text.trim() ? parse() : null;
    // An error at the very end is just unfinished typing.
    const error = result && "error" in result && result.error.index < text.trimEnd().length ? result.error : null;
    const [from, to] = error ? errorSpan(text, error.index, error.code) : [-1, -1];
    hlText.replaceChildren(
      ...tokenizeJoinText(text).map((t) => {
        const span = document.createElement("span");
        const kind = t.kind === "punct" ? "op" : t.kind;
        span.className = `t-${kind}${t.kind !== "space" && t.start >= from && t.start < to ? " t-err" : ""}`;
        span.textContent = text.slice(t.start, t.end);
        return span;
      }),
    );
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

  // `name` of a declared table → its table, for `alias.` completion.
  const tableOf = (ctx: JoinCompletion, name: string | null): string | undefined =>
    ctx.declared.find((d) => d.name === name)?.table;

  async function columnRows(ctx: JoinCompletion): Promise<Suggestion[]> {
    const table = tableOf(ctx, ctx.qualifier);
    if (!table) return [];
    const [columns, indexed] = await Promise.all([tableColumns(table), indexedColumns(table)]);
    const otherTable = ctx.otherSide ? tableOf(ctx, ctx.otherSide.qualifier) : undefined;
    const otherType = (cachedColumns(otherTable ?? "") ?? []).find((c) => c.name === ctx.otherSide?.column)?.type;
    return columns
      .filter((c) => c.name.toLowerCase().startsWith(ctx.partial.toLowerCase()))
      .map((c: Column) => {
        const note =
          otherType === undefined ? unjoinableReason(c.type) : (joinMismatch(c.type, otherType)?.note ?? null);
        return {
          label: c.name,
          insert: `${quoteJoinName(c.name)} `,
          note: note ?? c.type,
          ...(note === null && indexed.has(c.name) ? { tag: "indexed" } : {}),
          ...(note !== null ? { blocked: true } : {}),
        };
      });
  }

  // A foreign key between a declared table and the one being typed is offered as the whole clause.
  function foreignKeyClause(ctx: JoinCompletion, table: string, own: Column[]): string | undefined {
    const alias = aliasFor(table, new Set(ctx.declared.map((d) => d.name)));
    const q = `${quoteJoinName(table)} ${alias}`;
    for (const d of ctx.declared) {
      const theirs = cachedColumns(d.table) ?? [];
      const out = theirs.find((c) => c.references?.table === table);
      if (out?.references)
        return `${q} ON ${quoteJoinName(d.name)}.${quoteJoinName(out.name)} = ${alias}.${quoteJoinName(out.references.column)}`;
      const back = own.find((c) => c.references?.table === d.table);
      if (back?.references)
        return `${q} ON ${quoteJoinName(d.name)}.${quoteJoinName(back.references.column)} = ${alias}.${quoteJoinName(back.name)}`;
    }
    return undefined;
  }

  function tableRows(ctx: JoinCompletion): Suggestion[] {
    const used = new Set(ctx.declared.map((d) => d.table));
    const withKey: Suggestion[] = [];
    const rest: Suggestion[] = [];
    for (const table of listedTableNames()) {
      if (!table.toLowerCase().startsWith(ctx.partial.toLowerCase())) continue;
      const clause = used.has(table) ? undefined : foreignKeyClause(ctx, table, cachedColumns(table) ?? []);
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
      const candidates = listedTableNames().filter((t) => t.toLowerCase().startsWith(ctx.partial.toLowerCase()));
      const wanted = [...ctx.declared.map((d) => d.table), ...(candidates.length <= 8 ? candidates : [])];
      const missing = [...new Set(wanted)].filter((t) => !cachedColumns(t));
      if (missing.length > 0) {
        void Promise.allSettled(missing.map(tableColumns)).then(() => {
          if (token === suggest.token()) void update();
        });
      }
      rows = tableRows(ctx);
    } else if (ctx.expect === "qualifier") {
      rows = ctx.declared
        .filter((d) => d.name.toLowerCase().startsWith(ctx.partial.toLowerCase()))
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
    suggest.show(rows, ctx.head, -1);
  }

  // Column names and types are what catches an unknown column or a mismatched pair; read them for every table the text names.
  function prefetch(): void {
    const listed = new Set(listedTableNames());
    const wanted = [...new Set(joinCompletionAt(field.value).declared.map((d) => d.table))].filter(
      (t) => listed.has(t) && !cachedColumns(t),
    );
    if (wanted.length === 0) return;
    void Promise.allSettled(wanted.map(tableColumns)).then(() => {
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
