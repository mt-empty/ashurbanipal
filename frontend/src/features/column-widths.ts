import { $ } from "../core/dom.js";
import { state } from "../core/state.js";

// Grow-only per-column min-widths for the table being viewed, so a sort,
// filter or page change can widen a column but never shrinks it and shifts the
// columns after it. Scoped to source/schema/table; refresh clears it.
let scope = "";
const widths = new Map<string, number>();

function syncScope(): void {
  const current = `${state.source}|${state.schema}|${state.table}`;
  if (current === scope) return;
  scope = current;
  widths.clear();
}

export function columnMinWidth(name: string): number | undefined {
  syncScope();
  return widths.get(name);
}

// th is border-box (see styles.css), so the measured width is what the next
// render's min-width must be.
export function rememberColumnWidths(): void {
  syncScope();
  for (const th of $("thead").querySelectorAll<HTMLElement>("th[data-col]:not(.col-hidden)")) {
    const name = th.dataset.col as string;
    widths.set(name, Math.max(widths.get(name) ?? 0, th.getBoundingClientRect().width));
  }
}

export function resetColumnWidths(): void {
  widths.clear();
}
