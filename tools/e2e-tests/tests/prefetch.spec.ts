import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  APP_PATH,
  apiCall,
  dataWith,
  failRequests,
  goBack,
  goForward,
  gotoApp,
  holdRequests,
  selectTable,
  tableList,
  waitForIdle,
  waitForTable,
} from "./support/helpers";

/** The API route of every request the page sends from now on, siblings left out. */
function recordApiRoutes(page: Page): string[] {
  const routes: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    const at = path.indexOf("/api/");
    if (at >= 0 && !path.endsWith("/api/siblings")) routes.push(path.slice(at + 4));
  });
  return routes;
}

test("a deep link asks for its rows without waiting for the table list", async ({ page }) => {
  const release = await holdRequests(page, tableList("warehouse"));
  const rowsAsked = page.waitForRequest((r) => dataWith("table", "shipments")(r.url()));
  const opened = page.goto(`${APP_PATH}?schema=warehouse&table=shipments`);
  await rowsAsked;
  release();
  await opened;
  await waitForTable(page, "shipments");
});

test("start-up asks the server for each thing once", async ({ page }) => {
  const routes = recordApiRoutes(page);
  await gotoApp(page, "?schema=warehouse&table=shipments");
  await waitForTable(page, "shipments");
  expect(routes.sort()).toEqual(["/schemas", "/sources", "/table-counts", "/tables", "/tables/data"]);
});

test("a start-up guess for a schema that doesn't exist is asked again in the real one", async ({ page }) => {
  // Start-up falls back to the default schema (R5); the early answer was for the named one.
  const asked = page.waitForRequest((r) => apiCall("/tables/data", { table: "orders", schema: "public" })(r.url()));
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
  const routes = recordApiRoutes(page);
  await goBack(page);
  await waitForTable(page, "users");
  await goForward(page);
  await waitForTable(page, "orders");
  expect(routes).toEqual(["/tables/data", "/tables/data"]);
});

/** The URLs of data requests for `table` from now on. */
function recordDataRequests(page: Page, table: string): string[] {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (dataWith("table", table)(r.url())) urls.push(r.url());
  });
  return urls;
}

test("a pointer resting on a chip asks for its rows before the click, and only once", async ({ page }) => {
  await gotoApp(page);
  const asked = recordDataRequests(page, "orders");
  const early = page.waitForRequest((r) => dataWith("table", "orders")(r.url()));
  const chip = page.locator('#tables [data-table="orders"]');
  await chip.hover();
  await early;
  await chip.click();
  await waitForTable(page, "orders");
  expect(asked).toHaveLength(1);
});

test("Refresh drops a page asked for ahead of a click", async ({ page }) => {
  await gotoApp(page);
  const asked = recordDataRequests(page, "users");
  const early = page.waitForRequest((r) => dataWith("table", "users")(r.url()));
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
  const asked: string[] = [];
  page.on("request", (r) => {
    if (thirdPage(r.url())) asked.push(r.url());
  });
  const early = page.waitForRequest((r) => thirdPage(r.url()));
  await page.locator("#next").click();
  await early;
  await page.locator("#next").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 3");
  expect(asked).toHaveLength(1);
});
