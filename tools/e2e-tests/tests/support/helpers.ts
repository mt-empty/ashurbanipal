import { expect, type Page } from "@playwright/test";

export const APP_PATH = "/__ashurbanipal";

/** Waits for the current fetch and its render to settle. aria-busy clears
 * when the fetch's view-transition callback has run, but the fade that
 * follows can still make a clicked element unstable, so this also waits
 * for animations to end. Spinners, the refresh-icon spin, the new-row wash
 * and #load-bar run past the render, so they are not counted. */
export async function waitForIdle(page: Page) {
  await expect(page.locator("#data-table")).not.toHaveAttribute("aria-busy", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getAnimations().filter((a) => {
          const target = (a.effect as KeyframeEffect)?.target as Element | undefined;
          const cls = target?.classList;
          return (
            target?.id !== "refresh-icon" &&
            !target?.closest("#load-bar") &&
            !cls?.contains("row-spinner") &&
            !cls?.contains("row-new")
          );
        }).length,
      ),
    )
    .toBe(0);
}

/** Opens the app and waits for its automatic first table load to settle,
 * so a test's first action can't race it. Expects that load to succeed; a
 * test of a failing first load uses page.goto directly. */
export async function gotoApp(page: Page, query = "") {
  await page.goto(APP_PATH + query);
  await page.locator("#tables [data-table].active").waitFor();
  await waitForIdle(page);
}

/** Clicks a table chip and waits until it is the current table; #current
 * changes only after a successful load. */
export async function selectTable(page: Page, table: string) {
  await page.locator(`#tables [data-table="${table}"]`).click();
  await page.locator("#current").getByText(table, { exact: true }).waitFor();
  await waitForIdle(page);
}

/** Types a filter clause into #filter and submits it with Enter. */
export async function applyFilter(page: Page, clause: string) {
  const filter = page.locator("#filter");
  await filter.fill(clause);
  await filter.press("Enter");
  await waitForIdle(page);
}

/** Clears #filter as its native clear button does. The button is not a DOM
 * node Playwright can click, so this fires the `search` event it would. */
export async function clearFilterViaSearchEvent(page: Page) {
  const filter = page.locator("#filter");
  await filter.fill("");
  await filter.dispatchEvent("search");
  await waitForIdle(page);
}

/** The key of a table's entry in uiState's per-table maps (hiddenColumns,
 * sortByTable): source, schema and table. The demo is single-source. */
export function tableKey(table: string, schema = "public"): string {
  return JSON.stringify([null, schema, table]);
}

export function uiState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("ashurbanipal_ui");
    return raw ? JSON.parse(raw) : null;
  });
}
