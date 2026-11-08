import { loadData } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, el, reportError } from "../core/dom.js";
import {
  applyScopeParams,
  getLastPayload,
  joinAliases,
  joinInView,
  markFilterVerified,
  scopeIdentity,
  setAppliedFilterAst,
  state,
  tableInView,
} from "../core/state.js";
import type { Column, CommonValue, FilterCondition } from "../core/types.js";
import { filterClause, parseFilterDsl, quoteFilterValue } from "../lib/filter-dsl.js";
import { type Completion, completionAt, optionsFor } from "../lib/filter-tokens.js";
import { truncateType } from "../lib/join-types.js";
import { columnKey } from "./join-view.js";
import { createSuggestList, type Suggestion } from "./suggest-list.js";
import { keyDescriptionOf, tableMeta } from "./table-meta.js";

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

export function applyFilter(clause: string): void {
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

// Columns whose header ▾ came back empty, keyed like commonValueCache; the
// header draws their ▾ dimmed. Refresh clears it.
const emptyCommonValues = new Set<string>();

export function clearCommonValueCache(): void {
  commonValueCache.clear();
  emptyCommonValues.clear();
}

function markNoCommonValues(btn: HTMLElement): void {
  btn.classList.add("cv-none");
  btn.title = "no common values in the statistics";
}

// The table and column whose statistics describe a column: the viewed table's
// own, or a join column's source table. Null when there is no single table.
export function commonValueSource(col: Column): { table: string; column: string } | null {
  if (col.join === undefined) {
    const table = tableInView();
    return table === null ? null : { table, column: col.name };
  }
  return col.table !== undefined && col.column !== undefined ? { table: col.table, column: col.column } : null;
}

// A focusable control nested in the sortable th — stopPropagation so
// opening it doesn't also toggle sort. `filterName` is what a picked value
// filters on: the column's `alias.column` in a join view.
export function commonValuesButton(table: string, column: string, filterName: string): HTMLButtonElement {
  const btn = el("button");
  btn.type = "button";
  btn.className = "common-values-btn";
  btn.setAttribute("aria-label", `common values for ${filterName}`);
  btn.textContent = "▾";
  if (emptyCommonValues.has(scopeIdentity(table, column))) markNoCommonValues(btn);
  btn.onclick = (e) => {
    e.stopPropagation();
    showCommonValues(e, table, column, filterName);
  };
  return btn;
}

async function fetchCommonValues(table: string, column: string): Promise<CommonValue[]> {
  const params = new URLSearchParams({ table, column });
  applyScopeParams(params);
  return (await api<{ values: CommonValue[] }>(`/tables/common-values?${params}`)).values;
}

function commonValuesFor(table: string, column: string): Promise<string[]> {
  const key = scopeIdentity(table, column);
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
  // A column also matches mid-name (`at` finds created_at), after the prefix matches.
  if (ctx.expect === "column" && partial !== "") {
    matches.push(
      ...all.filter((s) => !s.label.toLowerCase().startsWith(partial) && s.label.toLowerCase().includes(partial)),
    );
  }
  // Nothing left to complete: a lone row identical to what is typed, except columns.
  const done = matches.length === 1 && matches[0].label.toLowerCase() === partial && ctx.expect !== "column";
  if (matches.length === 0 || done) {
    suggest.close();
    return;
  }
  suggest.show(matches, ctx.head);
}

// In a join view a plain name is the start table's column (spec/filter-dsl.md).
function columnNamed(name: string | null): Column | undefined {
  if (name === null) return undefined;
  return getLastPayload()?.columns.find((c) => columnKey(c) === name || (c.join === 0 && c.column === name));
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
  const plain = (labels: readonly string[]): Suggestion[] => labels.map((label) => ({ label, insert: label }));
  if (ctx.expect === "column") {
    const columns = getLastPayload()?.columns ?? [];
    const meta = tableMeta(tableInView());
    showFilterSuggestions(
      ctx,
      columns.map((c) => ({
        label: columnKey(c),
        insert: columnKey(c),
        note: truncateType(c.type),
        key: keyDescriptionOf(c, meta),
      })),
    );
  } else if (ctx.expect === "operator") {
    if (columnNamed(ctx.column)) showFilterSuggestions(ctx, plain(optionsFor("operator")));
  } else if (ctx.expect === "joiner" && ctx.partial !== "") {
    showFilterSuggestions(ctx, plain(optionsFor("joiner")));
  } else if (ctx.expect === "value") {
    const col = columnNamed(ctx.column);
    const source = col && commonValueSource(col);
    if (source) {
      commonValuesFor(source.table, source.column).then((values) => {
        if (token !== suggest.token() || document.activeElement !== input) return;
        const rows = values.map((value) => ({ label: value, insert: quoteFilterValue(value) }));
        showFilterSuggestions(ctx, rows);
      });
    }
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
// In a join the shares are of the source table's rows, which a note under them says.
function renderCommonValues(values: CommonValue[], table: string, filterName: string): void {
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
        applyFilter(filterClause(filterName, "=", v.value));
      };
      return btn;
    }),
  );
  if (joinInView()) list.append(el("p", "cv-note", `Shares of all rows in ${table}, not indicative of this join`));
}

async function showCommonValues(e: MouseEvent, table: string, column: string, filterName: string): Promise<void> {
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
  // Taken before the await: a scope switch meanwhile must not get this answer.
  const key = scopeIdentity(table, column);
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
  if (values.length === 0) {
    emptyCommonValues.add(key);
    markNoCommonValues(btn);
  }
  renderCommonValues(values, table, filterName);
}
