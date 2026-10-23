import { tableEl } from "../bootstrap/table-focus.js";
import { $ } from "../core/dom.js";
import { state, viewKey } from "../core/state.js";

// The scope and view the grid was drawn for; null before the first render.
let gridKey: string | null = null;
const stateKey = (): string => JSON.stringify([state.source, state.schema, viewKey(state.view)]);

export function markGridDrawn(): void {
  gridKey = stateKey();
}

// The grid shows another view than the one in the state, after a switch that could not wait.
export function gridIsStale(): boolean {
  return gridKey !== null && gridKey !== stateKey();
}

// A switch that could not wait for its rows (a schema, source or history
// change, ui-guidelines R14) leaves the old grid dimmed and inert until the
// new one renders, so none of its controls act on the view that replaced it.
export function syncGridLock(): void {
  if (gridKey === null) return;
  const locked = gridIsStale();
  tableEl.inert = locked;
  tableEl.toggleAttribute("data-stale", locked);
  // The two note buttons sit outside the table but act on the grid's columns.
  for (const id of ["columns-btn", "structure-btn", "sort-note-show", "all-hidden-show"]) {
    $<HTMLButtonElement>(id).disabled = locked;
  }
  if (!locked) return;
  // updatePager sets them again once the new grid renders.
  $<HTMLButtonElement>("prev").disabled = true;
  $<HTMLButtonElement>("next").disabled = true;
  for (const id of ["columns-pop", "cell-pop", "refby-pop", "cv-pop"]) $(id).hidePopover();
}
