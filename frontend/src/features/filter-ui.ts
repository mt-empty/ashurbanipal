import { loadData } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, reportError } from "../core/dom.js";
import { applyScopeParams, getLastPayload, markFilterVerified, setAppliedFilterAst, state } from "../core/state.js";
import type { CommonValue, FilterCondition, FilterOp } from "../core/types.js";
import { parseFilterDsl, quoteFilterValue } from "../lib/filter-dsl.js";
import { type Completion, completionAt } from "../lib/filter-tokens.js";

export function submitFilter(text: string): void {
  let ast: FilterCondition[] = [];
  if (text) {
    try {
      ast = parseFilterDsl(text);
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
  closeFilterSuggest();
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
// popover="manual" so it stays open while typing; arrow keys/Enter/Tab/
// Escape and light-dismiss (pointerdown listener below) are all
// hand-rolled to match. Enter accepts only a highlighted row, so Enter still
// submits; operator, value and joiner lists start with no row highlighted
// (Tab or an arrow key picks one). ----
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
// plain <input>, which has no native API for this.
function measureCaretPosition(input: HTMLInputElement): { x: number; y: number } {
  const mirror = document.createElement("div");
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
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    const inputRect = input.getBoundingClientRect();
    const offsetX = marker.getBoundingClientRect().left - mirror.getBoundingClientRect().left;
    return { x: inputRect.left + offsetX - input.scrollLeft, y: inputRect.bottom };
  } finally {
    mirror.remove();
  }
}

interface Suggestion {
  label: string;
  insert: string;
}
const FILTER_OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"];

let filterSuggestMatches: Suggestion[] = []; // rows currently shown, in display order
let filterSuggestIndex = -1; // highlighted row, -1 = none
let filterSuggestHead = ""; // input text up to (not including) the partial token being completed
// Supersedes an in-flight value lookup: bumped on every update and close, so a
// slow response never opens a list for text that has since changed.
let filterSuggestToken = 0;

function closeFilterSuggest(): void {
  filterSuggestToken++;
  filterSuggestMatches = [];
  filterSuggestIndex = -1;
  filterSuggestHead = "";
  const input = $<HTMLInputElement>("filter");
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  $("filter-suggest").hidePopover();
}

function renderFilterSuggest(): void {
  $("filter-suggest-list").replaceChildren(
    ...filterSuggestMatches.map((suggestion, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = suggestion.label;
      btn.title = suggestion.label; // long values are cut off with an ellipsis
      btn.className = i === filterSuggestIndex ? "active" : "";
      btn.id = `filter-suggest-${i}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(i === filterSuggestIndex));
      // Keeps focus (and the caret) in #filter — otherwise the button
      // would steal focus, firing #filter's blur handler and closing this
      // popup before its own click handler runs.
      btn.onmousedown = (e) => e.preventDefault();
      btn.onclick = () => acceptFilterSuggestion(i);
      return btn;
    }),
  );
  // Arrow-key moves change .active without mouse involvement, so the
  // list has to scroll itself.
  $("filter-suggest-list").children[filterSuggestIndex]?.scrollIntoView({ block: "nearest" });
  const input = $<HTMLInputElement>("filter");
  if (filterSuggestIndex >= 0) input.setAttribute("aria-activedescendant", `filter-suggest-${filterSuggestIndex}`);
  else input.removeAttribute("aria-activedescendant");
}

// The trailing space starts the next word, so accepting a column goes straight
// on to suggesting operators, and so on.
function acceptFilterSuggestion(i: number): void {
  const input = $<HTMLInputElement>("filter");
  input.value = `${filterSuggestHead}${filterSuggestMatches[i].insert} `;
  input.setSelectionRange(input.value.length, input.value.length);
  closeFilterSuggest();
  input.focus();
  updateFilterSuggestions();
}

// Per scope+table+column: the planner's list changes slowly, so one request
// serves every keystroke, a failed or empty answer included. Refresh clears it.
const commonValueCache = new Map<string, Promise<string[]>>();

export function clearCommonValueCache(): void {
  commonValueCache.clear();
}

function commonValuesFor(column: string): Promise<string[]> {
  const params = new URLSearchParams({ table: state.table ?? "", column });
  applyScopeParams(params);
  const key = params.toString();
  let values = commonValueCache.get(key);
  if (!values) {
    values = api<{ values: CommonValue[] }>(`/tables/common-values?${params}`)
      .then((r) => r.values.map((v) => v.value))
      .catch((e) => {
        console.warn("ashurbanipal: common values for suggestions failed", e);
        return [];
      });
    commonValueCache.set(key, values);
  }
  return values;
}

function showFilterSuggestions(ctx: Completion, all: Suggestion[], index: number): void {
  const input = $<HTMLInputElement>("filter");
  const partial = ctx.partial.toLowerCase();
  const matches = all.filter((s) => s.label.toLowerCase().startsWith(partial));
  // Nothing left to complete: a lone row identical to what is typed, except columns.
  const done = matches.length === 1 && matches[0].label.toLowerCase() === partial && ctx.expect !== "column";
  if (matches.length === 0 || done) {
    closeFilterSuggest();
    return;
  }
  filterSuggestMatches = matches;
  filterSuggestHead = ctx.head;
  filterSuggestIndex = index;
  renderFilterSuggest();
  const { x, y } = measureCaretPosition(input);
  $("filter-caret-anchor").style.left = `${x}px`;
  $("filter-caret-anchor").style.top = `${y}px`;
  $("filter-suggest").showPopover();
  input.setAttribute("aria-expanded", "true");
}

function updateFilterSuggestions(): void {
  const input = $<HTMLInputElement>("filter");
  if (input.selectionStart !== input.value.length) {
    closeFilterSuggest();
    return;
  }
  const ctx = completionAt(input.value);
  closeFilterSuggest();
  if (ctx.partial.startsWith("'")) return; // inside a quoted value
  const token = filterSuggestToken;
  const plain = (labels: string[]): Suggestion[] => labels.map((label) => ({ label, insert: label }));
  if (ctx.expect === "column") {
    showFilterSuggestions(ctx, plain((getLastPayload()?.columns ?? []).map((c) => c.name)), 0);
  } else if (ctx.expect === "operator") {
    showFilterSuggestions(ctx, plain(FILTER_OPERATORS), -1);
  } else if (ctx.expect === "joiner" && ctx.partial !== "") {
    showFilterSuggestions(ctx, plain(["AND", "OR"]), -1);
  } else if (ctx.expect === "value" && ctx.column && getLastPayload()?.columns.some((c) => c.name === ctx.column)) {
    commonValuesFor(ctx.column).then((values) => {
      if (token !== filterSuggestToken || document.activeElement !== input) return;
      const rows = values.map((value) => ({ label: value, insert: quoteFilterValue(value) }));
      showFilterSuggestions(ctx, rows, -1);
    });
  }
}

$<HTMLInputElement>("filter").oninput = updateFilterSuggestions;
$<HTMLInputElement>("filter").onfocus = updateFilterSuggestions;
$<HTMLInputElement>("filter").onblur = closeFilterSuggest;
$<HTMLInputElement>("filter").onkeydown = (e) => {
  if (filterSuggestMatches.length === 0) return;
  const count = filterSuggestMatches.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    filterSuggestIndex = (filterSuggestIndex + 1) % count;
    renderFilterSuggest();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    filterSuggestIndex = filterSuggestIndex <= 0 ? count - 1 : filterSuggestIndex - 1;
    renderFilterSuggest();
  } else if (e.key === "Enter" && filterSuggestIndex >= 0) {
    e.preventDefault();
    acceptFilterSuggestion(filterSuggestIndex);
  } else if (e.key === "Tab") {
    e.preventDefault();
    acceptFilterSuggestion(Math.max(filterSuggestIndex, 0));
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFilterSuggest();
  }
};
// addEventListener, not `document.onpointerdown =`: the single IDL slot on
// document is shared global state any other module could silently overwrite
// (frontend-style-guide.md §3).
document.addEventListener("pointerdown", (e) => {
  if (
    filterSuggestMatches.length > 0 &&
    !$("filter").contains(e.target as Node) &&
    !$("filter-suggest").contains(e.target as Node)
  ) {
    closeFilterSuggest();
  }
});

// ---- common-values header dropdown: a shortlist from Postgres planner
// statistics, never a full distinct-value scan — copy says "common
// values", not "all values", so it doesn't imply completeness it doesn't
// have. ----
let cvAnchor: HTMLElement | null = null;
let cvRequestToken = 0;
function renderCommonValues(values: CommonValue[], column: string): void {
  const list = $("cv-pop-list");
  if (values.length === 0) {
    const p = document.createElement("p");
    p.className = "cv-empty";
    p.textContent = "no common values available";
    list.replaceChildren(p);
    return;
  }
  list.replaceChildren(
    ...values.map((v) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cv-value";
      const val = document.createElement("span");
      val.textContent = v.value;
      const freq = document.createElement("span");
      freq.className = "cv-freq";
      freq.textContent = `${Math.round(v.freq * 100)}%`;
      btn.append(val, freq);
      btn.onclick = () => {
        $("cv-pop").hidePopover();
        applyFilterClause(column, "=", v.value);
      };
      return btn;
    }),
  );
}

export async function showCommonValues(e: MouseEvent, column: string): Promise<void> {
  const btn = e.currentTarget as HTMLElement;
  if (cvAnchor) cvAnchor.style.anchorName = "";
  cvAnchor = btn;
  cvAnchor.style.anchorName = "--cv-anchor";
  const list = $("cv-pop-list");
  const loading = document.createElement("p");
  loading.className = "cv-empty";
  loading.textContent = "loading…";
  list.replaceChildren(loading);
  $("cv-pop").showPopover();
  // A second header's ▾ can be clicked before the first request resolves;
  // the token discards a stale response instead of clobbering the column
  // actually showing.
  const token = ++cvRequestToken;
  const params = new URLSearchParams({ table: state.table ?? "", column });
  applyScopeParams(params);
  let values: CommonValue[];
  try {
    ({ values } = await api<{ values: CommonValue[] }>(`/tables/common-values?${params}`));
  } catch (err) {
    if (token !== cvRequestToken) return;
    const p = document.createElement("p");
    p.className = "cv-empty";
    p.textContent = (err as Error).message;
    list.replaceChildren(p);
    return;
  }
  if (token !== cvRequestToken) return;
  renderCommonValues(values, column);
}
