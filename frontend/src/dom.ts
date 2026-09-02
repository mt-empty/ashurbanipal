export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function setStatus(text: string): void {
  $("status").textContent = text;
}

// ---- per-cell copy (Clipboard API) ----
export async function copyText(text: string, btn: HTMLElement): Promise<void> {
  // Flip only the glyph on labelled buttons; icon-only ones flip themselves.
  const mark = btn.querySelector<HTMLElement>(".copy-icon") ?? btn;
  // Saved once — a re-click mid-flash would else capture the ✓/✗ as resting.
  if (mark.dataset.rest === undefined) mark.dataset.rest = mark.textContent ?? "";
  const resting = mark.dataset.rest;
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
    mark.textContent = "✓";
  } catch {
    mark.textContent = "✗";
  }
  setTimeout(() => {
    mark.textContent = resting;
  }, 800);
}
