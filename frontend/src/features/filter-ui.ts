import { loadData } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, el, reportError } from "../core/dom.js";
import {
  applyScopeParams,
  getLastPayload,
  joinAliases,
  markFilterVerified,
  setAppliedFilterAst,
  state,
  tableInView,
} from "../core/state.js";
import type { CommonValue, FilterCondition, FilterOp } from "../core/types.js";
import { parseFilterDsl, quoteFilterValue } from "../lib/filter-dsl.js";
import { type Completion, completionAt, optionsFor } from "../lib/filter-tokens.js";
import { columnKey } from "./join-view.js";
import { createSuggestList, type Suggestion } from "./suggest-list.js";

export function submitFilter(text: string): void {
  let ast: FilterCondition[] = [];
  if (text) {
    try {
      ast = parseFilterDsl(text, joinAliases());
    } catch (e) {
      reportError(e);
      return;
    }
  }
  state.filter = text;
  setAppliedFilterAst(ast);
  markFilterVerified(); // typed here, so a 400 on it is the user's to see
  state.offset = 0;
  loadData();
}

export function applyFilterClause(column: string, op: FilterOp, value?: string): void {
  // value is omitted for a valueless predicate (IS NULL). The composed
  // text round-trips through parseFilterDsl like a hand-typed clause —
  // quoteFilterValue guarantees it parses.
  const clause = value === undefined ? `${column} ${op}` : `${column} ${op} ${quoteFilterValue(value)}`;
  $<HTMLInputElement>("filter").value = clause;
  submitFilter(clause);
}

// AND-join of `column = value` clauses — the composite-key drill-in from
// referenced-by. quoteFilterValue on each value keeps the whole string
// parseable by parseFilterDsl (which handles AND between conditions).
export function applyFilterClauses(pairs: { column: string; value: string }[]): void {
  const clause = pairs.map((p) => `${p.column} = ${quoteFilterValue(p.value)}`).join(" AND ");
  $<HTMLInputElement>("filter").value = clause;
  submitFilter(clause);
}

$<HTMLFormElement>("filter-form").onsubmit = (e) => {
  e.preventDefault();
  suggest.close();
  submitFilter($<HTMLInputElement>("filter").value.trim());
};
// The native clear button on a search input fires "search" but never
// submits the form, so clearing it left state.filter stale until some
// other action reset it. addEventListener, not `.onsearch =`: the
// onsearch IDL property only exists in Chromium/legacy WebKit and is a
// silent no-op in Firefox.
$<HTMLInputElement>("filter").addEventListener("search", () => {
  if ($<HTMLInputElement>("filter").value.trim() === "") $<HTMLFormElement>("filter-form").requestSubmit();
});

// ---- filter autocomplete: a cursor-anchored popup that suggests whatever the
// DSL grammar allows next — a column (start, after AND/OR/NOT), an operator
// (after a column), a value of that column (after an operator; the planner's
// common values), AND/OR (once a letter is typed after a finished condition).
// Only inspects text before the cursor (lib/filter-tokens.ts) — never judges
// the filter as a whole, so it doesn't duplicate parseFilterDsl's accept/reject
// job. Scoped to the cursor sitting at the end of the text — mid-string edits
// get no suggestions.
//
// Arrow keys/Enter/Tab/Escape and light-dismiss (pointerdown listener below)
// are hand-rolled. Enter accepts only a highlighted row, so Enter still
// submits; every list starts with no row highlighted (Tab or an arrow key
// picks one). ----
const CARET_MIRROR_PROPS: Extract<keyof CSSStyleDeclaration, string>[] = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  // border-*-style matters too, not just width: a border's used width
  // collapses to 0 when style is "none" (the mirror's default), so without
  // these the mirror omits #filter's UA-default border and the measured
  // caret position is off by that width.
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "wordSpacing",
];

// Renders an invisible clone of the text up to the cursor with identical
// font metrics — the standard technique for locating a caret position in a
// plain <input>, which has no native API for this. Returns the caret's x
// within the input's own box.
function measureCaretX(input: HTMLInputElement): number {
  const mirror = el("div");
  const computed = getComputedStyle(input);
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre",
    top: "0",
    left: "-9999px",
  });
  // Runtime-only copy of computed style values keyed by camelCase property
  // name; keyof CSSStyleDeclaration also covers readonly members (length,
  // parentRule, methods), which the settable-property view below sidesteps.
  const mirrorStyle = mirror.style as unknown as Record<string, string>;
  const computedStyle = computed as unknown as Record<string, string>;
  for (const prop of CARET_MIRROR_PROPS) mirrorStyle[prop] = computedStyle[prop];
  mirror.textContent = input.value.slice(0, input.selectionStart ?? 0);
  const marker = el("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    return marker.getBoundingClientRect().left - mirror.getBoundingClientRect().left - input.scrollLeft;
  } finally {
    mirror.remove();
  }
}

const filterInput = $<HTMLInputElement>("filter");

// The trailing space starts the next word, so accepting a column goes straight
// on to suggesting operators, and so on.
const suggest = createSuggestList({
  input: filterInput,
  popup: $("filter-suggest"),
  list: $("filter-suggest-list"),
  idPrefix: "filter-suggest",
  accept: (suggestion, head) => {
    filterInput.value = `${head}${suggestion.insert} `;
    filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
    suggest.close();
    filterInput.focus();
    updateFilterSuggestions();
  },
  // In the page's flow (not the top layer), so it scrolls with the field and
  // passes behind the sticky table header. Kept inside the field's width.
  place: () => {
    const popup = $("filter-suggest");
    const room = filterInput.parentElement ? filterInput.parentElement.clientWidth - popup.offsetWidth : 0;
    popup.style.left = `${Math.max(0, Math.min(filterInput.offsetLeft + measureCaretX(filterInput), room))}px`;
  },
});

// Per scope+table+column: the planner's list changes slowly, so one request
// serves every keystroke, a failed or empty answer included. Refresh clears it.
const commonValueCache = new Map<string, Promise<string[]>>();

export function clearCommonValueCache(): void {
  commonValueCache.clear();
}

async function fetchCommonValues(table: string, column: string): Promise<CommonValue[]> {
  const params = new URLSearchParams({ table, column });
  applyScopeParams(params);
  return (await api<{ values: CommonValue[] }>(`/tables/common-values?${params}`)).values;
}

function commonValuesFor(table: string, column: string): Promise<string[]> {
  const params = new URLSearchParams({ table, column });
  applyScopeParams(params);
  const key = params.toString();
  let values = commonValueCache.get(key);
  if (!values) {
    values = fetchCommonValues(table, column)
      .then((rows) => rows.map((v) => v.value))
      .catch((e) => {
        console.warn("ashurbanipal: common values for suggestions failed", e);
        return [];
      });
    commonValueCache.set(key, values);
  }
  return values;
}

function showFilterSuggestions(ctx: Completion, all: Suggestion[]): void {
  const partial = ctx.partial.toLowerCase();
  const matches = all.filter((s) => s.label.toLowerCase().startsWith(partial));
  // Nothing left to complete: a lone row identical to what is typed, except columns.
  const done = matches.length === 1 && matches[0].label.toLowerCase() === partial && ctx.expect !== "column";
  if (matches.length === 0 || done) {
    suggest.close();
    return;
  }
  suggest.show(matches, ctx.head);
}

// In a join view a plain name is the start table's column (spec/filter-dsl.md).
function isColumn(name: string | null): boolean {
  return (
    name !== null &&
    (getLastPayload()?.columns.some((c) => columnKey(c) === name || (c.join === 0 && c.column === name)) ?? false)
  );
}

function updateFilterSuggestions(): void {
  const input = filterInput;
  if (input.selectionStart !== input.value.length) {
    suggest.close();
    return;
  }
  const ctx = completionAt(input.value);
  suggest.close();
  if (ctx.partial.startsWith("'")) return; // inside a quoted value
  const token = suggest.token();
  // Common values are a per-table query; a join view has no single table to ask.
  const table = tableInView();
  const plain = (labels: readonly string[]): Suggestion[] => labels.map((label) => ({ label, insert: label }));
  if (ctx.expect === "column") {
    showFilterSuggestions(ctx, plain((getLastPayload()?.columns ?? []).map(columnKey)));
  } else if (ctx.expect === "operator") {
    if (isColumn(ctx.column)) showFilterSuggestions(ctx, plain(optionsFor("operator")));
  } else if (ctx.expect === "joiner" && ctx.partial !== "") {
    showFilterSuggestions(ctx, plain(optionsFor("joiner")));
  } else if (ctx.expect === "value" && ctx.column && isColumn(ctx.column) && table !== null) {
    commonValuesFor(table, ctx.column).then((values) => {
      if (token !== suggest.token() || document.activeElement !== input) return;
      const rows = values.map((value) => ({ label: value, insert: quoteFilterValue(value) }));
      showFilterSuggestions(ctx, rows);
    });
  }
}

filterInput.oninput = updateFilterSuggestions;
filterInput.onfocus = updateFilterSuggestions;

// ---- common-values header dropdown: a shortlist from Postgres planner
// statistics, never a full distinct-value scan — copy says "common
// values", not "all values", so it doesn't imply completeness it doesn't
// have. ----
let cvAnchor: HTMLElement | null = null;
let cvRequestToken = 0;
function renderCommonValues(values: CommonValue[], column: string): void {
  const list = $("cv-pop-list");
  if (values.length === 0) {
    const p = el("p", "cv-empty", "no common values available");
    list.replaceChildren(p);
    return;
  }
  list.replaceChildren(
    ...values.map((v) => {
      const btn = el("button");
      btn.type = "button";
      btn.className = "cv-value";
      const val = el("span");
      val.textContent = v.value;
      const freq = el("span", "cv-freq", `${Math.round(v.freq * 100)}%`);
      btn.append(val, freq);
      btn.onclick = () => {
        $("cv-pop").hidePopover();
        applyFilterClause(column, "=", v.value);
      };
      return btn;
    }),
  );
}

export async function showCommonValues(e: MouseEvent, table: string, column: string): Promise<void> {
  const btn = e.currentTarget as HTMLElement;
  if (cvAnchor) cvAnchor.style.anchorName = "";
  cvAnchor = btn;
  cvAnchor.style.anchorName = "--cv-anchor";
  const list = $("cv-pop-list");
  const loading = el("p", "cv-empty", "loading…");
  list.replaceChildren(loading);
  $("cv-pop").showPopover();
  // A second header's ▾ can be clicked before the first request resolves;
  // the token discards a stale response instead of clobbering the column
  // actually showing.
  const token = ++cvRequestToken;
  let values: CommonValue[];
  try {
    values = await fetchCommonValues(table, column);
  } catch (err) {
    if (token !== cvRequestToken) return;
    const p = el("p", "cv-empty", (err as Error).message);
    list.replaceChildren(p);
    return;
  }
  if (token !== cvRequestToken) return;
  renderCommonValues(values, column);
}
