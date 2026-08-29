import { expect, type Page } from "@playwright/test";

export const APP_PATH = "/__ashurbanipal";

/** Waits for an in-flight loadData() fetch AND its render to fully settle.
 * aria-busy (fetchTableData's own signal) only proves the *fetch* finished
 * — dbviewer.html wraps every re-render in document.startViewTransition(),
 * which keeps animating (and can leave the clicked element's bounding box
 * "unstable," or intercept the next click via its snapshot overlay) for a
 * short window after that. document.getAnimations() covers view-transition
 * pseudo-element animations too, so waiting for it to empty out is the
 * real signal, not a guessed timeout. Skipping this under heavy parallel
 * load is what caused sporadic "element is not stable"/misfired clicks.
 *
 * Deliberately excludes .row-spinner animations: a sidebar row's spinner
 * used to be able to get stuck running forever (fetchTableData's finally
 * block cleared the wrong row's loading flag if state.table changed
 * mid-flight — fixed by capturing `table` into a local const, see
 * loadDataToken in dbviewer.html). Counting it here would make this
 * helper hang on an unrelated stuck spinner from an earlier action rather
 * than the settle condition this helper actually exists to check.
 *
 * Excludes .row-new (the 3s new-row wash after a manual refresh) for the
 * same reason: it's a post-settle decoration, not part of the render, and
 * counting it would add ~3s to every wait after a highlighted refresh. */
export async function waitForIdle(page: Page) {
  await expect(page.locator("table")).not.toHaveAttribute("aria-busy", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getAnimations().filter((a) => {
          const cls = (a.effect as KeyframeEffect)?.target?.classList;
          return !cls?.contains("row-spinner") && !cls?.contains("row-new");
        }).length,
      ),
    )
    .toBe(0);
}

/** Navigates to the app root and waits for its own automatic initial-table
 * load to fully settle. Playwright gives each test a fresh browser context
 * by default, so localStorage/URL state is already isolated per-test
 * without any manual clearing.
 *
 * The settle-wait matters because loadData() used to have no per-request
 * staleness guard (now fixed via loadDataToken, see dbviewer.html), so if
 * a test clicks a different table (selectTable) before this page's own
 * loadTables()-triggered default-table fetch resolves, whichever
 * request's response landed last would win the render — #current could
 * end up correctly labeled while the actual rendered rows/columns were
 * the OTHER table's. Waiting here closes that race for every test, once,
 * instead of each test having to remember to guard against its own first
 * click. */
export async function gotoApp(page: Page, query = "") {
  await page.goto(APP_PATH + query);
  // Bounded/tolerant: a deliberately-erroring initial load (e.g.
  // loading-and-errors.spec.ts's invalid-sort-column case) never gets an
  // .active button at all — that's a legitimate scenario, not something
  // to hang on, so this gives up after a few seconds rather than the
  // default 30s if nothing shows up.
  await page
    .locator("#tables button.active")
    .waitFor({ timeout: 5_000 })
    .catch(() => {});
  await waitForIdle(page);
}

/** Clicks a sidebar table button and waits for it to actually become the
 * loaded/current table (not just clicked) — #current only updates after a
 * successful loadData() (see dbviewer.html's updateActiveTableChrome), so
 * this also doubles as "wait for the fetch to resolve." */
export async function selectTable(page: Page, table: string) {
  await page.locator(`#tables button[data-table="${table}"]`).click();
  await page.locator("#current").getByText(table, { exact: true }).waitFor();
  await waitForIdle(page);
}

/** Types a filter clause into #filter and submits it via the form (Enter),
 * matching how a real user submits — the #apply button does the same
 * thing, this just picks one consistent path for tests. */
export async function applyFilter(page: Page, clause: string) {
  const filter = page.locator("#filter");
  await filter.fill(clause);
  await filter.press("Enter");
  await waitForIdle(page);
}

/** Clears #filter the way a user would via the native search-input's
 * built-in clear affordance: emptying the value and firing the `search`
 * event (dbviewer.html's #filter.onsearch handler), which resubmits an
 * empty filter. Chromium's built-in clear "x" isn't a real DOM node
 * Playwright can click, so this dispatches the same event it would fire. */
export async function clearFilterViaSearchEvent(page: Page) {
  const filter = page.locator("#filter");
  await filter.fill("");
  await filter.dispatchEvent("search");
  await waitForIdle(page);
}

export function uiState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("ashurbanipal_ui");
    return raw ? JSON.parse(raw) : null;
  });
}
