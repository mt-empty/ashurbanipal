import { $ } from "../core/dom.js";
import { state, viewKey } from "../core/state.js";
import type { View } from "../core/types.js";

// Grow-only per-column min-widths for the table being viewed, so a sort,
// filter or page change can widen a column but never shrinks it and shifts the
// columns after it. Scoped to source/schema/view; refresh clears it.
let scope = "";
const widths = new Map<string, number>();

// Captured when a load starts, so a render that runs after the selection has
// moved on still records its widths under the table it shows.
export function widthScopeOf(view: View): string {
  return `${state.source}|${state.schema}|${viewKey(view)}`;
}

export function useWidthScope(next: string): void {
  if (next === scope) return;
  scope = next;
  widths.clear();
}

export function columnMinWidth(name: string): number | undefined {
  return widths.get(name);
}

// th is border-box (see styles.css), so the measured width is what the next
// render's min-width must be.
export function rememberColumnWidths(): void {
  for (const th of $("thead").querySelectorAll<HTMLElement>("th[data-col]:not(.col-hidden)")) {
    const name = th.dataset.col as string;
    widths.set(name, Math.max(widths.get(name) ?? 0, th.getBoundingClientRect().width));
  }
}

export function resetColumnWidths(): void {
  widths.clear();
}
