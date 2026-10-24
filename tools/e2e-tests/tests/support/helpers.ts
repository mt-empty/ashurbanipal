import { expect, type Page, type Route } from "@playwright/test";

export const APP_PATH = "/__ashurbanipal";

/** Waits for the current fetch and its render to settle (docs/e2e-testing-guidelines.md §2).
 * Spinners, the refresh-icon spin, the new-row wash and #load-bar outlast
 * the render, so their animations are not waited on. */
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

/** Opens the app (on another server when `baseUrl` is given) and waits for
 * its start-up to settle, failed or not, so a test's first action can't race it. */
export async function gotoApp(page: Page, query = "", baseUrl = "") {
  await page.goto(baseUrl + APP_PATH + query);
  await waitForFirstLoad(page);
}

/** Reloads the page and waits for its start-up as gotoApp does. */
export async function reloadApp(page: Page) {
  await page.reload();
  await waitForFirstLoad(page);
}

// <main> is aria-busy from the first byte until the app's start-up chain settles.
async function waitForFirstLoad(page: Page) {
  await expect(page.locator("#main")).not.toHaveAttribute("aria-busy", "true");
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

export const tableData = (url: URL) => url.pathname.endsWith("/api/tables/data");

/** Matches /api/tables/data requests whose `param` is `value`; takes a URL or its text. */
export const dataWith = (param: string, value: string) => (url: URL | string) => {
  const u = typeof url === "string" ? new URL(url) : url;
  return tableData(u) && u.searchParams.get(param) === value;
};

/** Fails the requests `match` accepts with a 503, as an unavailable database would. */
export const failTableData = (page: Page, match: (url: URL) => boolean) =>
  page.route(match, (route) => route.fulfill(problem(503, "Service Unavailable", "database_error")));

/** Answers data requests sorted by `col` with the backend's 400 for a column the table lacks. */
export const rejectSort = (page: Page, col: string) =>
  page.route(dataWith("sort", col), (route) =>
    route.fulfill(problem(400, `not allowed: column "${col}"`, "unknown_column")),
  );

/** Holds every request `match` accepts until the returned function is
 * called, then answers each with `finish` (by default, sends it on). */
export async function holdRequests(
  page: Page,
  match: (url: URL) => boolean,
  finish: (route: Route) => Promise<void> = (route) => route.continue(),
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(match, async (route) => {
    await gate;
    await finish(route);
  });
  return release;
}

/** A route.fulfill() payload for an RFC 9457 error, with the members spec/openapi.yaml's ProblemDetails requires. */
export function problem(status: number, title: string, code: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({ type: "about:blank", title, status, code }),
  };
}

export function uiState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("ashurbanipal_ui");
    return raw ? JSON.parse(raw) : null;
  });
}
