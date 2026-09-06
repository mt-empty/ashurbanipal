import { loadData } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, reportError } from "../core/dom.js";
import { applyScopeParams, getLastPayload, markFilterVerified, setAppliedFilterAst, state } from "../core/state.js";
import type { CommonValue, FilterCondition, FilterOp } from "../core/types.js";
import { parseFilterDsl, quoteFilterValue } from "../lib/filter-dsl.js";

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

$<HTMLFormElement>("filter-form").onsubmit = (e) => {
  e.preventDefault();
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

// ---- filter column autocomplete: a cursor-anchored popup suggesting a
// column name wherever the DSL grammar allows a new condition to start
// (empty, or right after AND/OR/NOT), prefix-filtered by the partial
// column name already typed. Only inspects text immediately before the
// cursor — never judges the filter as a whole, so it doesn't duplicate
// parseFilterDsl's accept/reject job. Scoped to the cursor sitting at
// the end of the text — mid-string edits get no suggestions.
//
// popover="manual" so it stays open while typing; arrow keys/Enter/Tab/
// Escape and light-dismiss (pointerdown listener below) are all
// hand-rolled to match. ----
const FILTER_COND_FIRST = /^\s*(?:NOT\s+)?$/i;
const FILTER_COND_AFTER_LOGIC = /(^|\s)(?:AND|OR)\s+(?:NOT\s+)?$/i;
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

let filterSuggestMatches: string[] = []; // column names currently shown, in display order
let filterSuggestIndex = -1; // highlighted row, -1 = none
let filterSuggestHead = ""; // input text up to (not including) the partial token being completed

function closeFilterSuggest(): void {
  filterSuggestMatches = [];
  filterSuggestIndex = -1;
  filterSuggestHead = "";
  $("filter-suggest").hidePopover();
}

function renderFilterSuggest(): void {
  $("filter-suggest-list").replaceChildren(
    ...filterSuggestMatches.map((name, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = name;
      btn.className = i === filterSuggestIndex ? "active" : "";
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
}

function acceptFilterSuggestion(i: number): void {
  const input = $<HTMLInputElement>("filter");
  input.value = filterSuggestHead + filterSuggestMatches[i];
  input.setSelectionRange(input.value.length, input.value.length);
  closeFilterSuggest();
  input.focus();
}

function updateFilterSuggestions(): void {
  const input = $<HTMLInputElement>("filter");
  const pos = input.selectionStart;
  if (pos !== input.value.length) {
    closeFilterSuggest();
    return;
  }
  const before = input.value.slice(0, pos ?? 0);
  const tokenStart = before.search(/\S*$/);
  const head = before.slice(0, tokenStart);
  const partial = before.slice(tokenStart);
  if (!(FILTER_COND_FIRST.test(head) || FILTER_COND_AFTER_LOGIC.test(head))) {
    closeFilterSuggest();
    return;
  }
  const columns = (getLastPayload()?.columns ?? []).map((c) => c.name);
  filterSuggestMatches = columns.filter((name) => name.toLowerCase().startsWith(partial.toLowerCase()));
  if (filterSuggestMatches.length === 0) {
    closeFilterSuggest();
    return;
  }
  filterSuggestHead = head;
  filterSuggestIndex = 0;
  renderFilterSuggest();
  const { x, y } = measureCaretPosition(input);
  $("filter-caret-anchor").style.left = `${x}px`;
  $("filter-caret-anchor").style.top = `${y}px`;
  $("filter-suggest").showPopover();
}

$<HTMLInputElement>("filter").oninput = updateFilterSuggestions;
$<HTMLInputElement>("filter").onfocus = updateFilterSuggestions;
$<HTMLInputElement>("filter").onblur = closeFilterSuggest;
$<HTMLInputElement>("filter").onkeydown = (e) => {
  if (filterSuggestMatches.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    filterSuggestIndex = (filterSuggestIndex + 1) % filterSuggestMatches.length;
    renderFilterSuggest();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    filterSuggestIndex = (filterSuggestIndex - 1 + filterSuggestMatches.length) % filterSuggestMatches.length;
    renderFilterSuggest();
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acceptFilterSuggestion(filterSuggestIndex);
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
