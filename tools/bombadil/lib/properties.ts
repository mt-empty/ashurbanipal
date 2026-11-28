import { always, eventually, type Formula, next, now, Pure } from "@antithesishq/bombadil";
import { lastAction } from "@antithesishq/bombadil/browser/defaults/actions";
import { busy, consoleErrors, errorText, pageSize, rowCount, settled, uncaught, url, viewKey } from "./state.ts";

// Known gap: a view transition interrupted by the next one rejects its `ready` promise, which
// bootstrap/controller.ts and features/record-view.ts leave unhandled.
const SKIPPED_TRANSITION = /AbortError: Transition was skipped/;

export const noConsoleErrors = always(() => consoleErrors.current.every((m) => SKIPPED_TRANSITION.test(m)));

export const noUnhandledRejections = always(() =>
  uncaught.current.filter((t) => t.startsWith("Uncaught (in promise)")).every((t) => SKIPPED_TRANSITION.test(t)),
);

// Every fetch and redraw finishes, so the grid never stays busy.
export const busySettles = always(
  now(() => busy.current).implies(eventually(() => !busy.current).within(10, "seconds")),
);

// Messages #error shows on purpose, each with the code that writes it.
const DESIGNED_ERRORS = [
  // bootstrap/controller.ts: a sort on a column the engine can't order is dropped, then explained.
  /^cannot sort by .+: its type has no ordering$/,
  // features/filter-ui.ts submitFilter: the typed filter doesn't parse (lib/filter-dsl.ts FilterDslError).
  / at position \d+$/,
  // features/filter-ui.ts submitFilter marks a typed filter verified, so the server's 400 for an
  // unknown column or a bad value is shown as it came (spec/protocol.md §5.4.2).
  /^not allowed: column "/,
  /^invalid filter: /,
];

// #error is for failures the reader can act on. Clicking around a healthy server on the seed
// database earns only the designed ones above.
export const noErrorBanner = always(() => {
  const text = errorText.current;
  return text === null || DESIGNED_ERRORS.some((re) => re.test(text));
});

export const pageNeverOverflows = always(() => rowCount.current <= pageSize.current);

// Bombadil keeps acting while a reload loads, so a later action can move the view on first.
// The check is the first settled state still on the reloaded URL; a URL change before it
// passes. Past MAX_WAIT states (about 10 s of actions) the reload counts as stuck.
const MAX_WAIT = 300;

function firstSettledMatches(before: string, beforeUrl: string, left: number): Formula | boolean {
  if (url.current !== beforeUrl) return true;
  if (settled.current)
    return viewKey.current === before || new Pure(`reloaded view ${viewKey.current} differs from ${before}`, false);
  return left > 0 && next(() => firstSettledMatches(before, beforeUrl, left - 1));
}

// A reload from a settled view comes back to the same view: the URL and saved state restore it.
export const reloadKeepsTheView = always(() => {
  if (!settled.current) return true;
  const before = viewKey.current;
  const beforeUrl = url.current;
  return next(() => (lastAction.current === "Reload" ? firstSettledMatches(before, beforeUrl, MAX_WAIT) : true));
});
