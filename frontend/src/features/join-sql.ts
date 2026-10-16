import { $ } from "../core/dom.js";
import type { Column } from "../core/types.js";
import type { Draft } from "../lib/join-draft.js";
import { type JoinParse, parseJoin, quoteJoinName } from "../lib/join-dsl.js";
import { type JoinCompletion, joinCompletionAt, tokenizeJoinText } from "../lib/join-tokens.js";
import { joinBlocker, unjoinableReason } from "../lib/join-types.js";
import { cachedColumns, indexedColumns, knownCatalog, tableColumns } from "./join-catalog.js";
import { attachOverlayHighlight } from "./overlay-highlight.js";
import { listedTableNames } from "./sidebar.js";
import { createSuggestList, type Suggestion } from "./suggest-list.js";

// The SQL half of the join overlay: a text field coloured like the filter box,
// with suggestions for what the grammar allows next. The text is only ever
// parsed in the browser (spec/join-dsl.md).

export interface JoinSql {
  setText(text: string): void;
  text(): string;
  // The text parsed against the catalog the page holds.
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
    c === null ? [] : c.map((col) => `${nameAt(pos)}.${quoteJoinName(col)}`),
  );
  const select =
    draft.columns.some((c) => c !== null) && picked.length > 0 ? `SELECT ${picked.join(", ")}` : "SELECT *";
  return [select, ...lines].join("\n");
}

export function mountJoinSql(onChange: () => void): JoinSql {
  const field = $<HTMLTextAreaElement>("join-sql");
  const hlText = $("join-sql-hl-text");
  const popup = $("join-sql-suggest");

  const parse = (): JoinParse => parseJoin(field.value, knownCatalog());

  function render(): void {
    const text = field.value;
    field.rows = Math.max(4, text.split("\n").length + 1);
    const result = text.trim() ? parse() : null;
    // An error at the very end is just unfinished typing.
    const at = result && "error" in result && result.error.index < text.trimEnd().length ? result.error.index : -1;
    hlText.replaceChildren(
      ...tokenizeJoinText(text).map((t) => {
        const span = document.createElement("span");
        const kind = t.kind === "name" ? "column" : t.kind === "punct" ? "op" : t.kind;
        span.className = `t-${kind}${t.start <= at && at < t.end ? " t-err" : ""}`;
        span.textContent = text.slice(t.start, t.end);
        return span;
      }),
    );
    // The trailing newline keeps the copy as tall as the field.
    hlText.append("\n");
  }
  attachOverlayHighlight(field, render);

  const suggest = createSuggestList({
    input: field,
    popup,
    list: $("join-sql-suggest-list"),
    idPrefix: "join-sql-suggest",
    accept: (suggestion, head) => {
      field.value = `${head}${suggestion.insert}`;
      field.setSelectionRange(field.value.length, field.value.length);
      suggest.close();
      field.focus();
      onChange();
      update();
    },
  });

  // `name` of a declared table → its columns, for `alias.` completion.
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
        const reason = otherType === undefined ? unjoinableReason(c.type) : joinBlocker(c.type, otherType);
        const tag = indexed.has(c.name) ? " · indexed" : "";
        return {
          label: `${c.name} (${c.type})${tag}`,
          insert: `${quoteJoinName(c.name)} `,
          ...(reason ? { blocked: reason } : {}),
        };
      });
  }

  // A foreign key between a declared table and the one being typed is offered as the whole clause.
  function tableRows(ctx: JoinCompletion): Suggestion[] {
    const taken = new Set(ctx.declared.map((d) => d.name));
    const rows: Suggestion[] = [];
    for (const table of listedTableNames()) {
      if (!table.toLowerCase().startsWith(ctx.partial.toLowerCase())) continue;
      const q = quoteJoinName(table);
      const own = cachedColumns(table) ?? [];
      const snippet = taken.has(table) ? undefined : foreignKeyClause(ctx, table, q, own);
      if (snippet) rows.push({ label: snippet, insert: `${snippet} ` });
      rows.push({ label: table, insert: `${q} ` });
    }
    return rows;
  }

  function foreignKeyClause(ctx: JoinCompletion, table: string, q: string, own: Column[]): string | undefined {
    for (const d of ctx.declared) {
      const theirs = cachedColumns(d.table) ?? [];
      const out = theirs.find((c) => c.references?.table === table);
      if (out?.references)
        return `${q} ON ${quoteJoinName(d.name)}.${quoteJoinName(out.name)} = ${q}.${quoteJoinName(out.references.column)}`;
      const back = own.find((c) => c.references?.table === d.table);
      if (back?.references)
        return `${q} ON ${quoteJoinName(d.name)}.${quoteJoinName(back.references.column)} = ${q}.${quoteJoinName(back.name)}`;
    }
    return undefined;
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
        .map((d) => ({ label: d.name, insert: `${quoteJoinName(d.name)}.` }));
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

  field.addEventListener("input", () => {
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
