import { actions, registerCustomAction, weighted } from "@antithesishq/bombadil/browser";
import {
  back,
  clicks,
  forward,
  inputs,
  reload,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";
import { columnNames, inJoin, settled } from "./state.ts";

// Types a filter into the box and submits it, as Enter would (features/filter-ui.ts submitFilter).
const applyFilter = registerCustomAction("applyFilter", async (document, _window, text: string) => {
  const input = document.getElementById("filter") as HTMLInputElement | null;
  const form = document.getElementById("filter-form") as HTMLFormElement | null;
  if (!input || !form) throw new Error("no #filter / #filter-form on this page");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
});

// Filters built from the visible columns, valid for any column type, plus one that doesn't
// parse and one that clears the filter. Random typing rarely writes a filter that applies.
const filters = actions(() => {
  if (inJoin.current || !settled.current) return [];
  return [
    applyFilter(""),
    ...columnNames.current.flatMap((c) => [
      applyFilter(`${c} IS NULL`),
      applyFilter(`${c} IS NOT NULL`),
      applyFilter(`NOT ${c} IS NULL`),
      applyFilter(`${c} =`),
    ]),
  ];
});

// One generator for the whole run, so these weights decide the mix: mostly clicks, some
// filtering and history, and reload rarely enough that runs still get deep into a view.
export const explore = weighted([
  [10, clicks],
  [3, filters],
  [2, inputs],
  [2, back],
  [1, forward],
  [1, scroll],
  [1, reload],
  [1, waitOnce],
]);
