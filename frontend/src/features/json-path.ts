import { ApiError } from "../core/api.js";
import { getAppliedFilterAst, lastRowsForView } from "../core/state.js";
import type { Column, FilterCondition, FilterOp, PathStep, ViewData } from "../core/types.js";
import { pathText } from "../lib/filter-dsl.js";
import { truncateType } from "../lib/join-types.js";
import { compareText, type Doc, nodeAt, scanJson, spanAt, valuesAt } from "../lib/json-doc.js";
import { columnKey, conditionColumn, conditionNames } from "./join-view.js";

// ---- JSON path filters: what the page says and marks around a
// condition with a `path`. Everything here reads the rows already loaded; none
// of it asks the server. ----

// A JSON number filters only in its shortest form: some engines read `1.50`,
// `1e2` or a huge integer back in another form than the cell shows.
export function numberFilterable(text: string): boolean {
  return String(Number(text)) === text;
}

// Parsed JSON cells per payload and column. A page holds at most 100 rows.
const docCache = new WeakMap<ViewData, Map<string, Doc[]>>();

export function docsOf(data: ViewData, col: Column): Doc[] {
  let byColumn = docCache.get(data);
  if (!byColumn) {
    byColumn = new Map();
    docCache.set(data, byColumn);
  }
  let docs = byColumn.get(col.name);
  if (!docs) {
    docs = [];
    for (const row of data.rows) {
      const raw = row[col.name];
      const doc = raw == null ? null : scanJson(raw);
      if (doc) docs.push(doc);
    }
    byColumn.set(col.name, docs);
  }
  return docs;
}

function filterName(c: FilterCondition): string {
  const col = conditionColumn(c);
  const column = col ? columnKey(col) : c.column;
  return (c.path && pathText(column, c.path)) ?? column;
}

// Why a path is refused before sending: the server takes one only on a class
// json column. Null when every path is on one, or the columns aren't known yet.
export function pathColumnProblem(ast: readonly FilterCondition[]): string | null {
  for (const c of ast) {
    const col = c.path && conditionColumn(c);
    if (col && col.class !== "json")
      return `${columnKey(col)} is ${truncateType(col.type)}. Only json and jsonb columns take a path (->).`;
  }
  return null;
}

const NUMBER_LIKE = /^\s*-?[0-9]+(?:\.[0-9]+)?\s*$/;

// A path compares as text, so an order comparison against a number surprises:
// '10' < '9'. Dates and words order correctly as text, so they get no note.
export function textOrderNotice(ast: readonly FilterCondition[]): string | null {
  for (const c of ast) {
    if (!c.path || !["<", ">", "<=", ">=", "BETWEEN"].includes(c.op)) continue;
    const values = Array.isArray(c.value) ? c.value : [c.value ?? ""];
    if (values.some((v) => NUMBER_LIKE.test(v))) return `${filterName(c)} is compared as text, so 10 comes before 9.`;
  }
  return null;
}

// Text inside JSON matches exactly, so a value that differs from a loaded one
// only by case finds nothing. Names that loaded value; null when there is none.
// Only for a lone condition: with others, any of them could have emptied the result.
export function caseOnlyHint(ast: readonly FilterCondition[]): string | null {
  const data = lastRowsForView();
  if (data === null || ast.length !== 1) return null;
  for (const c of ast) {
    if (!c.path || c.op !== "=" || c.not || typeof c.value !== "string") continue;
    const col = conditionColumn(c, data.columns);
    if (!col) continue;
    const typed = c.value;
    const values = valuesAt(docsOf(data, col), c.path);
    if (values.some((v) => v.text === typed)) continue;
    const near = values.find((v) => v.text.toLowerCase() === typed.toLowerCase());
    if (near)
      return `Text inside JSON is matched exactly, so ${typed} is not ${near.text}. The loaded rows have ${String(c.path.at(-1))} = ${near.text}. Use ILIKE to ignore case.`;
  }
  return null;
}

// A server from before paths refuses the field as unknown, in one of a few
// wordings ("unknown field", "unknown key", "Unrecognized field").
export function olderServerMessage(e: unknown, ast: readonly FilterCondition[]): string | null {
  if (!(e instanceof ApiError) || e.code !== "invalid_filter" || !ast.some((c) => c.path)) return null;
  if (!/\b(?:unknown|unrecognized)\b/i.test(e.message) || !/\bpath\b/.test(e.message)) return null;
  return "This server doesn't support JSON paths yet. Update ashurbanipal on the host to use them.";
}

const CHECKABLE_OPS = new Set<FilterOp>(["=", "!=", "IN", "IS NOT NULL"]);

// The applied filter's path conditions on this column that a document can show
// a match for. IS NULL matches by absence, so there is nothing to mark.
function markableConditions(col: Column): FilterCondition[] {
  return getAppliedFilterAst().filter((c) => c.path && !c.not && c.op !== "IS NULL" && conditionNames(c, col));
}

// The members a document matched: equal to the value for = and IN, not equal
// for !=, present otherwise. A JSON null reads as NULL, so it never matches.
// Under OR a row can pass by another branch, so the page marks only what it can check here.
function matchedIn(doc: Doc, conditions: readonly FilterCondition[]): PathStep[][] {
  const paths: PathStep[][] = [];
  const anyOr = getAppliedFilterAst().some((c) => c.logic === "OR");
  for (const c of conditions) {
    if (anyOr && !CHECKABLE_OPS.has(c.op)) continue;
    const path = c.path ?? [];
    const node = nodeAt(doc.root, path);
    const text = node ? compareText(doc, node) : null;
    if (text === null) continue;
    if (c.op === "=" && text !== c.value) continue;
    if (c.op === "!=" && text === c.value) continue;
    if (c.op === "IN" && !(Array.isArray(c.value) && c.value.includes(text))) continue;
    paths.push(path);
  }
  return paths;
}

// Whether a tree line's path is a member the applied filter matched, for the
// cell popup's and record view's trees.
export function matchedPath(col: Column, doc: Doc): ((path: readonly PathStep[]) => boolean) | undefined {
  const conditions = markableConditions(col);
  if (conditions.length === 0) return undefined;
  const matched = new Set(matchedIn(doc, conditions).map((p) => JSON.stringify(p)));
  return matched.size === 0 ? undefined : (path) => matched.has(JSON.stringify(path));
}

// The parts of a JSON cell's text that the applied filter matched, for the grid's wash.
export function matchSpans(col: Column, raw: string): { start: number; end: number }[] {
  const conditions = markableConditions(col);
  if (conditions.length === 0) return [];
  const doc = scanJson(raw);
  if (!doc) return [];
  const spans = matchedIn(doc, conditions)
    .flatMap((path) => spanAt(doc, path) ?? [])
    .sort((a, b) => a.start - b.start);
  // A member inside one already marked (a key under a matched object) adds nothing.
  const kept: { start: number; end: number }[] = [];
  for (const span of spans) if (span.start >= (kept.at(-1)?.end ?? 0)) kept.push(span);
  return kept;
}
