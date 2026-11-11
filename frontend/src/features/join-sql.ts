import { $ } from "../core/dom.js";
import { manySchemas, refFor, schemaRefFor, state } from "../core/state.js";
import type { Column, TableRef } from "../core/types.js";
import { type Draft, draftToDef } from "../lib/join-draft.js";
import { type JoinPairSide, type JoinParse, parseJoin, printJoin, quoteJoinName } from "../lib/join-dsl.js";
import {
  type DeclaredTable,
  type JoinCompletion,
  type JoinToken,
  joinCompletionAt,
  tokenizeJoinText,
} from "../lib/join-tokens.js";
import { findForeignKey, joinMismatch, pairNote, truncateType } from "../lib/join-types.js";
import { distinctRefs } from "../lib/table-ref.js";
import {
  cachedColumns,
  cachedTablesIn,
  catalogVersion,
  indexedColumns,
  knownCatalog,
  knownSchemas,
  readIndexedColumns,
  tableColumns,
  tablesIn,
  tablesInFailure,
} from "./join-catalog.js";
import { attachOverlayHighlight, tokenSpans } from "./overlay-highlight.js";
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

  // Known for the tables whose columns were read; an unknown pair is allowed.
  const pairCheck = (a: JoinPairSide, b: JoinPairSide): string | null => {
    const ac = cachedColumns(refFor(a))?.find((c) => c.name === a.column);
    const bc = cachedColumns(refFor(b))?.find((c) => c.name === b.column);
    return ac && bc ? (joinMismatch(ac, bc)?.message ?? null) : null;
  };
  // Highlight, dialog and suggestions all ask on each keystroke; parse once per text and catalog.
  let memo: { text: string; version: number; result: JoinParse } | null = null;
  const parse = (): JoinParse => {
    const text = field.value;
    const version = catalogVersion();
    if (memo?.text !== text || memo.version !== version) {
      const catalog = knownCatalog();
      const scopeSchema = state.scope.schema ?? undefined;
      memo = {
        text,
        version,
        result: parseJoin(text, { catalog, schemas: knownSchemas(catalog), scopeSchema, pairCheck }),
      };
    }
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
  const tableOf = (ctx: JoinCompletion, name: string | null): TableRef | undefined => {
    const d = ctx.declared.find((t) => t.name === name);
    return d && refFor(d);
  };

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
    const other = (otherTable ? (cachedColumns(otherTable) ?? []) : []).find((c) => c.name === ctx.otherSide?.column);
    const starts = startsWith(ctx);
    return columns
      .filter((c) => starts(c.name))
      .map((c: Column) => {
        const note = pairNote(c, other);
        return {
          label: c.name,
          insert: `${quoteJoinName(c.name)} `,
          note: note ?? truncateType(c.type),
          ...(note === null && indexed?.has(c.name) ? { tag: "indexed" } : {}),
          ...(note !== null ? { blocked: true } : {}),
        };
      });
  }

  type Earlier = { table: TableRef; columns: readonly Column[] }[];
  // A foreign key between a declared table and the one being typed is offered as the whole clause.
  function foreignKeyClause(
    ctx: JoinCompletion,
    earlier: Earlier,
    taken: ReadonlySet<string>,
    ref: TableRef,
  ): string | undefined {
    const { table } = ref;
    const fk = findForeignKey(earlier, ref, cachedColumns(ref) ?? []);
    if (!fk) return undefined;
    const alias = aliasFor(table, taken);
    const left = quoteJoinName(ctx.declared[fk.at].name);
    return `${quoteJoinName(table)} ${alias} ON ${left}.${quoteJoinName(fk.leftColumn)} = ${alias}.${quoteJoinName(fk.rightColumn)}`;
  }

  // `schema` is the one typed before the table, if any; the head already holds it.
  function tableRows(
    ctx: JoinCompletion,
    candidates: readonly { name: string; count: string }[],
    schema: string | undefined,
  ): Suggestion[] {
    const own = (s: string | undefined) => s ?? state.scope.schema;
    const used = new Set(ctx.declared.filter((d) => own(d.schema) === own(schema)).map((d) => d.table));
    const taken = new Set(ctx.declared.map((d) => d.name));
    const earlier: Earlier = ctx.declared.map(refFor).map((table) => ({ table, columns: cachedColumns(table) ?? [] }));
    const withKey: Suggestion[] = [];
    const rest: Suggestion[] = [];
    for (const { name: table, count } of candidates) {
      const clause = used.has(table) ? undefined : foreignKeyClause(ctx, earlier, taken, refFor({ schema, table }));
      if (clause) withKey.push({ label: clause, insert: `${clause} `, tag: "foreign key" });
      else
        rest.push({
          label: table,
          insert: `${quoteJoinName(table)} `,
          note: used.has(table) ? "already used · add as alias" : count,
        });
    }
    return [...withKey, ...rest];
  }

  // The other schemas, offered after FROM and JOIN; picking one goes on to its tables.
  function schemaRows(ctx: JoinCompletion): Suggestion[] {
    if (!manySchemas()) return [];
    const starts = startsWith(ctx);
    return state.schemas
      .filter((s) => s !== state.scope.schema && starts(s))
      .map((s) => ({ label: `${s}.`, insert: `${quoteJoinName(s)}.`, note: "schema" }));
  }

  async function update(): Promise<void> {
    suggest.close();
    const token = suggest.token();
    if (field.selectionStart !== field.value.length) return;
    const ctx = joinCompletionAt(field.value);
    let rows: Suggestion[] = [];
    if (ctx.expect === "table") {
      const schema = ctx.qualifier ?? undefined;
      const listed = cachedTablesIn(schema);
      if (!listed && schema !== undefined && state.schemas.includes(schema)) {
        tablesIn(schemaRefFor(schema)).then(
          () => {
            if (token === suggest.token()) void update();
          },
          () => {},
        );
      }
      const starts = startsWith(ctx);
      const candidates = (listed ?? []).filter((t) => starts(t.name));
      // Foreign key clauses need the columns of the declared tables and of a few candidates; they appear once read.
      const candidateRefs = candidates.length <= 8 ? candidates.map((t) => refFor({ schema, table: t.name })) : [];
      const missing = distinctRefs([...ctx.declared.map(refFor), ...candidateRefs]).filter((t) => !cachedColumns(t));
      if (missing.length > 0) {
        void Promise.allSettled(missing.map(tableColumns)).then((results) => {
          if (anyRead(results) && token === suggest.token()) void update();
        });
      }
      rows = [...tableRows(ctx, candidates, schema), ...(schema === undefined ? schemaRows(ctx) : [])];
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

  // Column names and types are what catches an unknown column or a mismatched pair; read them for every
  // table the text names that its schema lists, so a half-typed name is never asked for.
  function prefetch(): void {
    const declared = joinCompletionAt(field.value).declared;
    // Another schema's table list comes first, so its names can be checked and its columns read.
    const unread = new Set(
      declared
        .map((d) => d.schema)
        .filter(
          (s): s is string => s !== undefined && state.schemas.includes(s) && !cachedTablesIn(s) && !tablesInFailure(s),
        ),
    );
    for (const schema of unread) {
      tablesIn(schemaRefFor(schema)).then(
        () => {
          prefetch();
          render();
          onChange();
        },
        () => {},
      );
    }
    const listed = (d: DeclaredTable): boolean => cachedTablesIn(d.schema)?.some((t) => t.name === d.table) ?? false;
    const named = declared.filter(listed);
    const wanted = distinctRefs(named.map(refFor)).filter((t) => !cachedColumns(t));
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
