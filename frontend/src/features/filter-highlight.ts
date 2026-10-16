import { $ } from "../core/dom.js";
import { filterDslErrorAt } from "../lib/filter-dsl.js";
import { endsInUnfinishedWord, tokenizeFilterDsl } from "../lib/filter-tokens.js";
import { attachOverlayHighlight } from "./overlay-highlight.js";

// A coloured copy of #filter's text drawn behind the transparent-text input, so
// the native caret, selection and IME keep working. The copy is dropped (`.plain`)
// when the text overflows the field, because WebKit does not report its scroll.
const input = $<HTMLInputElement>("filter");
const wrap = $("filter-wrap");
const textEl = $("filter-hl-text");

// The parser rejects longer text outright (FILTER_MAX_DSL_BYTES), so there is
// nothing to colour, and one span per token of a huge paste would blow the stack.
const MAX_HIGHLIGHT_CHARS = 1024;

function render(): void {
  const text = input.value;
  if (text.length > MAX_HIGHLIGHT_CHARS) {
    textEl.replaceChildren();
    wrap.classList.add("plain");
    return;
  }
  const { tokens } = tokenizeFilterDsl(text);
  // Submit trims before parsing, so the error is found in the trimmed text.
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const error = filterDslErrorAt(trimmed);
  // An error at the very end is just unfinished typing, and an open quote is
  // only unfinished until it closes.
  let at = error && error.index < trimmed.length && !error.message.startsWith("unterminated") ? error.index + lead : -1;
  const bad = tokens.find((t) => t.start <= at && at < t.end);
  if (bad && bad.end >= lead + trimmed.length && endsInUnfinishedWord(text)) at = -1;
  textEl.replaceChildren(
    ...tokens.map((t) => {
      const span = document.createElement("span");
      span.className = `t-${t.kind}${t.start <= at && at < t.end ? " t-err" : ""}`;
      span.textContent = text.slice(t.start, t.end);
      return span;
    }),
  );
  wrap.classList.toggle("plain", input.scrollWidth > input.clientWidth);
}

attachOverlayHighlight(input, render);
