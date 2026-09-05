export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
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
  select.replaceChildren(...values.map((v) => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    return opt;
  }));
  select.value = selected;
}

// ---- per-cell copy (Clipboard API) ----
export async function copyText(text: string, btn: HTMLElement): Promise<void> {
  const mark = btn.querySelector<HTMLElement>(".copy-icon") ?? btn;
  // Saved once so a re-click mid-flash can't capture the ✓/✗ as the resting glyph.
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
