// Throws on a miss: every id here is in the co-shipped static markup, so a
// null is a markup/build bug to surface, not a branch every caller must
// carry.
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no element with id ${id}`);
  return el as T;
}

// Same policy as $, for a selector against a freshly-cloned <template> or a
// known-present subtree.
export function qs<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
}

export function setStatus(text: string): void {
  $("status").textContent = text;
}

// The only writers of #error, so there is one place to look for what can
// surface a message in the error banner and what clears it again.
export function reportError(e: unknown): void {
  $("error").textContent = (e as Error).message;
}

export function clearError(): void {
  $("error").textContent = "";
}

export function populateSelect(select: HTMLSelectElement, values: string[], selected: string): void {
  select.replaceChildren(
    ...values.map((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      return opt;
    }),
  );
  select.value = selected;
}

// Flashes `glyph` on `el`, then restores whatever glyph was resting there.
// The resting value is recorded on dataset.rest the first time only, so a
// re-click mid-flash restores the real glyph rather than the transient one.
export function flashIcon(el: HTMLElement, glyph: string, ms = 800): void {
  if (el.dataset.rest === undefined) el.dataset.rest = el.textContent ?? "";
  const rest = el.dataset.rest ?? "";
  el.textContent = glyph;
  setTimeout(() => {
    el.textContent = rest;
  }, ms);
}

// ---- per-cell copy (Clipboard API) ----
export async function copyText(text: string, btn: HTMLElement): Promise<void> {
  const mark = btn.querySelector<HTMLElement>(".copy-icon") ?? btn;
  let glyph = "✓";
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else {
      // Clipboard API needs a secure context (https/localhost); fall back
      // for plain-http.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  } catch {
    glyph = "✗";
  }
  flashIcon(mark, glyph);
}
