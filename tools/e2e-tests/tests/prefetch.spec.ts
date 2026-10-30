import { expect, test } from "./support/fixtures";
import {
  APP_PATH,
  apiCall,
  apiRoute,
  dataWith,
  failRequests,
  goBack,
  goForward,
  gotoApp,
  holdRequests,
  recordRequests,
  selectTable,
  tableList,
  waitForIdle,
  waitForTable,
} from "./support/helpers";

/** API calls other than the siblings poll, which runs on its own timer. */
function isApiCall(r: { url(): string }): boolean {
  const route = apiRoute(r.url());
  return route !== undefined && route !== "/siblings";
}

test("a deep link asks for its rows without waiting for the table list", async ({ page }) => {
  const release = await holdRequests(page, tableList("warehouse"));
  const rowsAsked = page.waitForRequest(dataWith("table", "shipments"));
  const opened = page.goto(`${APP_PATH}?schema=warehouse&table=shipments`);
  await rowsAsked;
  release();
  await opened;
  await waitForTable(page, "shipments");
});

test("start-up asks the server for each thing once", async ({ page }) => {
  const asked = recordRequests(page, isApiCall);
  await gotoApp(page, "?schema=warehouse&table=shipments");
  await waitForTable(page, "shipments");
  expect(asked.map(apiRoute).sort()).toEqual(["/schemas", "/sources", "/table-counts", "/tables", "/tables/data"]);
});

test("a start-up guess for a schema that doesn't exist is asked again in the real one", async ({ page }) => {
  // Start-up falls back to the default schema (R5); the early answer was for the named one.
  const asked = page.waitForRequest(apiCall("/tables/data", { table: "orders", schema: "public" }));
  await gotoApp(page, "?schema=no_such_schema&table=orders");
  await asked;
  await waitForTable(page, "orders");
});

test("the table list still shows when the row counts fail", async ({ page }) => {
  await failRequests(page, apiCall("/table-counts"));
  await gotoApp(page);
  await expect(page.locator('#tables [data-table="orders"]')).toBeVisible();
  await expect(page.locator('#tables [data-table="orders"] .count')).toHaveText("?");
});

test("Back and Forward within one schema ask only for the rows", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  const asked = recordRequests(page, isApiCall);
  await goBack(page);
  await waitForTable(page, "users");
  await goForward(page);
  await waitForTable(page, "orders");
  expect(asked.map(apiRoute)).toEqual(["/tables/data", "/tables/data"]);
});

test("a pointer resting on a chip asks for its rows before the click, and only once", async ({ page }) => {
  await gotoApp(page);
  const asked = recordRequests(page, dataWith("table", "orders"));
  const early = page.waitForRequest(dataWith("table", "orders"));
  const chip = page.locator('#tables [data-table="orders"]');
  await chip.hover();
  await early;
  await chip.click();
  await waitForTable(page, "orders");
  expect(asked).toHaveLength(1);
});

test("Refresh drops a page asked for ahead of a click", async ({ page }) => {
  await gotoApp(page);
  const asked = recordRequests(page, dataWith("table", "users"));
  const early = page.waitForRequest(dataWith("table", "users"));
  await page.locator('#tables [data-table="users"]').hover();
  await early;
  await page.locator("#refresh").click();
  await waitForIdle(page);
  await selectTable(page, "users");
  expect(asked).toHaveLength(2);
});

test("after one Next, the page after is asked for before the next click, and only once", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const thirdPage = apiCall("/tables/data", { table: "orders", offset: "100" });
  const asked = recordRequests(page, thirdPage);
  const early = page.waitForRequest(thirdPage);
  await page.locator("#next").click();
  await early;
  await page.locator("#next").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 3");
  expect(asked).toHaveLength(1);
});
