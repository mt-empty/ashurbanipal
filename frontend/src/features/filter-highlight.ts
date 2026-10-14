import { $ } from "../core/dom.js";
import { filterDslErrorAt } from "../lib/filter-dsl.js";
import { tokenizeFilterDsl } from "../lib/filter-tokens.js";

// A coloured copy of #filter's text drawn behind the (transparent-text) input,
// so the field keeps its native caret, selection, IME and copy/paste. The
// parser's rejection point is underlined once the text has moved past it.
// When the text overflows the field the copy is dropped and the input shows its
// own text: WebKit does not report a text field's horizontal scroll, so the
// copy could not follow it.
const input = $<HTMLInputElement>("filter");
const wrap = $("filter-wrap");
const textEl = $("filter-hl-text");

function render(): void {
  const text = input.value;
  const { tokens } = tokenizeFilterDsl(text);
  const error = filterDslErrorAt(text);
  // An error at the very end is just unfinished typing, and an open quote is
  // only unfinished until it closes.
  const at = error && error.index < text.length && !error.message.startsWith("unterminated") ? error.index : -1;
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

// Programmatic writes (accepting a suggestion, a URL restore, click-to-filter)
// fire no input event, so every write to .value is caught here instead of at
// each caller.
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
