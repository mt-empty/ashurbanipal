import { $ } from "./dom.js";

// Static markup (index.html), so this resolves once at module init rather
// than on every fetch and every focus restore.
export const tableEl = document.querySelector<HTMLTableElement>("table")!;

// ---- focus preservation across thead/tbody re-renders ----
// replaceChildren() detaches whatever was focused inside it, and the
// browser falls back to <body> — a real defect for keyboard users on every
// sort/page/filter/table-switch change. Capture the focused cell's
// position before the replace and restore it afterward, falling back to
// the table itself (tabindex="-1") if that slot no longer exists. Covers
// both tbody and thead (the common-values ▾ button).
interface FocusCapture {
  region: string; // "thead" | "tbody"
  rowIndex: number;
  colIndex: number;
  className: string;
}

export function captureTableFocus(): FocusCapture | null {
  const active = document.activeElement;
  if (!active || !tableEl.contains(active)) return null;
  const cell = active.closest("th, td");
  const tr = active.closest("tr");
  if (!cell || !tr) return null;
  return {
    region: tr.parentElement!.id,
    rowIndex: [...tr.parentElement!.children].indexOf(tr),
    colIndex: [...tr.children].indexOf(cell),
    className: active.className,
  };
}

export function restoreTableFocus(captured: FocusCapture | null): void {
  if (!captured) return;
  const tr = $(captured.region)?.children[captured.rowIndex];
  const cell = tr?.children[captured.colIndex];
  // className can carry more than one class (e.g. a focused FK cell's
  // button is both "cell-text" and "fk-cell") — join them into a single
  // compound selector instead of interpolating the raw string, which
  // `.${className}` would otherwise parse as a descendant combinator.
  const classSelector = captured.className
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  const target = classSelector ? cell?.querySelector<HTMLElement>(classSelector) : null;
  (target ?? tableEl).focus();
}
