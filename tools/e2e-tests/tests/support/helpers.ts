import { expect, type Page } from "@playwright/test";

export const APP_PATH = "/__ashurbanipal";

/** Waits for an in-flight loadData() fetch to settle, via the same
 * aria-busy attribute fetchTableData() sets/clears (dbviewer.html). Needed
 * after any action that triggers a fetch (select table, apply/clear
 * filter, sort, page) before reading row/pager state — without it, a test
 * can race a stale pre-fetch DOM snapshot against the real post-fetch one. */
export async function waitForIdle(page: Page) {
  await expect(page.locator("table")).not.toHaveAttribute("aria-busy", "true");
}

/** Navigates to the app root. Playwright gives each test a fresh browser
 * context by default, so localStorage/URL state is already isolated
 * per-test without any manual clearing. */
export async function gotoApp(page: Page, query = "") {
  await page.goto(APP_PATH + query);
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
