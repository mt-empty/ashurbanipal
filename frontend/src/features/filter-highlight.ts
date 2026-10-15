import { $ } from "../core/dom.js";
import { filterDslErrorAt } from "../lib/filter-dsl.js";
import { tokenizeFilterDsl } from "../lib/filter-tokens.js";

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
  const at =
    error && error.index < trimmed.length && !error.message.startsWith("unterminated") ? error.index + lead : -1;
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

// Programmatic writes to .value fire no input event, so they re-render here.
const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
if (valueProp?.get && valueProp.set) {
  const { get, set } = valueProp;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(v: string) {
      set.call(this, v);
      render();
    },
  });
}

input.addEventListener("input", render);
window.addEventListener("resize", render);
render();
