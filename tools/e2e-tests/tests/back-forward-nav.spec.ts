import { test, expect, type Page } from "./support/fixtures";
import {
  applyFilter,
  clearFilterViaSearchEvent,
  dataWith,
  goBack,
  goForward,
  gotoApp,
  holdRequests,
  reloadApp,
  selectTable,
  tableList,
  waitForIdle,
} from "./support/helpers";

const historyLength = (page: Page) => page.evaluate(() => history.length);
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

async function expectParam(page: Page, name: string, value: string | null) {
  await expect.poll(() => param(page, name)).toBe(value);
  await waitForIdle(page);
}

async function expectTable(page: Page, table: string) {
  await page.locator("#current").getByText(table, { exact: true }).waitFor();
  await waitForIdle(page);
  expect(param(page, "table")).toBe(table);
}

test("browser back/forward steps through table navigation history", async ({ page }) => {
  await gotoApp(page);
  // The auto-loaded initial view replaces the loaded entry rather than pushing one.
  const start = await historyLength(page);

  await selectTable(page, "users");
  expect(await historyLength(page)).toBe(start + 1);
  await selectTable(page, "orders");
  await selectTable(page, "products");

  await goBack(page);
  await expectTable(page, "orders");
  await goBack(page);
  await expectTable(page, "users");

  await goForward(page);
  await expectTable(page, "orders");
  await goForward(page);
  await expectTable(page, "products");
});

test("back and forward still work after a reload", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  await selectTable(page, "products");
  const before = await historyLength(page);

  await reloadApp(page);
  await expectTable(page, "products");
  expect(await historyLength(page)).toBe(before);

  await goBack(page);
  await expectTable(page, "orders");
  await goBack(page);
  await expectTable(page, "users");
  await goForward(page);
  await expectTable(page, "orders");
});

test("back pressed while start-up is still loading opens that entry", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  // The superseded start-up's request may be gone by the time it is let through.
  const release = await holdRequests(page, tableList("public"), (route) => route.continue().catch(() => {}));
  await page.reload();
  const reloaded = page.waitForEvent("load");
  await goBack(page);
  await reloaded;
  release();
  await expectTable(page, "users");
});

test("a fragment-only step back leaves a pending table switch alone", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const release = await holdRequests(page, dataWith("table", "users"));
  const sent = page.waitForRequest((r) => dataWith("table", "users")(r.url()));
  await page.locator('#tables [data-table="users"]').click();
  await sent;
  await page.evaluate(() => {
    location.hash = "note";
  });
  await goBack(page);
  release();
  await expectTable(page, "users");
});

test("back from a deep link's next table returns to the linked table", async ({ page }) => {
  await gotoApp(page, "?table=orders");
  await expectTable(page, "orders");
  await selectTable(page, "products");
  await goBack(page);
  await expectTable(page, "orders");
});

test("navigating to a different table from a back-stepped position truncates the forward stack", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  await selectTable(page, "products");
  const full = await historyLength(page);

  await goBack(page);
  await expectTable(page, "orders");

  // Diverging here replaces the stale "products" forward entry.
  await selectTable(page, "sessions");
  expect(await historyLength(page)).toBe(full);

  await goBack(page);
  await expectTable(page, "orders");
  await goForward(page);
  await expectTable(page, "sessions");
});

test("back returns to the unfiltered table after filtering and switching away", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  await selectTable(page, "products");

  await goBack(page);
  await expectTable(page, "orders");
  await expect(page.locator("#filter")).toHaveValue("status = completed");

  await goBack(page);
  await expectParam(page, "filter", null);
  await expectTable(page, "orders");
  await expect(page.locator("#filter")).toHaveValue("");
});

test("filter, sort and page each add an entry that back steps through", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const entries = await historyLength(page);
  await applyFilter(page, "status = completed");
  expect(await historyLength(page)).toBe(entries + 1);
  await page.locator("thead th[data-col]").first().click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  expect(await historyLength(page)).toBe(entries + 2);
  const sort = param(page, "sort");
  expect(sort).not.toBeNull();
  await page.locator("#next").click();
  await waitForIdle(page);
  expect(await historyLength(page)).toBe(entries + 3);
  const offset = param(page, "offset");
  expect(offset).not.toBe("0");

  await goBack(page);
  await expectParam(page, "offset", "0");
  expect(param(page, "sort")).toBe(sort);
  await goBack(page);
  await expectParam(page, "sort", null);
  await expect(page.locator("#filter")).toHaveValue("status = completed");
  await goBack(page);
  await expectParam(page, "filter", null);
  await expect(page.locator("#filter")).toHaveValue("");

  await goForward(page);
  await goForward(page);
  await goForward(page);
  await expectParam(page, "offset", offset);
  expect(param(page, "sort")).toBe(sort);
  await expect(page.locator("#filter")).toHaveValue("status = completed");
});

test("clearing a filter adds an entry, and back brings the filter back", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  const entries = await historyLength(page);
  await clearFilterViaSearchEvent(page);
  expect(await historyLength(page)).toBe(entries + 1);
  expect(param(page, "filter")).toBeNull();

  await goBack(page);
  await expectParam(page, "filter", "status = completed");
  await expect(page.locator("#filter")).toHaveValue("status = completed");
});

test("a load that changes nothing adds no entry", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  const entries = await historyLength(page);
  await applyFilter(page, "status = completed");
  await page.locator("#refresh").click();
  await waitForIdle(page);
  expect(await historyLength(page)).toBe(entries);
});

test("sorting the initially-loaded table adds an entry, and back unsorts it", async ({ page }) => {
  await gotoApp(page);
  const start = await historyLength(page);
  await page.locator("thead th[data-col]").first().click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  expect(await historyLength(page)).toBe(start + 1);
  expect(param(page, "sort")).not.toBeNull();
  await goBack(page);
  await expectParam(page, "sort", null);
});
