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
  problem,
  recordRequests,
  selectTable,
  tableData,
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

// Without a scope in the URL, start-up's early requests leave it out and are
// matched once the server's defaults are known.
for (const [query, table] of [
  ["?schema=warehouse&table=shipments", "shipments"],
  ["?table=orders", "orders"],
]) {
  test(`start-up asks the server for each thing once (${query})`, async ({ page }) => {
    const asked = recordRequests(page, isApiCall);
    await gotoApp(page, query);
    await waitForTable(page, table);
    expect(asked.map(apiRoute).sort()).toEqual(["/schemas", "/sources", "/table-counts", "/tables", "/tables/data"]);
  });
}

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

test("Back while an earlier step's table list is on its way asks for the rows once", async ({ page }) => {
  // Same-named tables in two schemas: warehouse's list also names users.
  await page.route(tableList("warehouse"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tables.push({ name: "users" });
    await route.fulfill({ response, json: body });
  });
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  await page.locator("#schema-select").selectOption("warehouse");
  await expect(page.locator('#tables [data-table="carriers"]')).toBeVisible();
  await waitForIdle(page);
  const release = await holdRequests(page, tableList("public"));
  const asked = recordRequests(page, dataWith("table", "users"));
  await goBack(page);
  await goBack(page);
  release();
  await waitForTable(page, "users");
  await expect(page.locator('#tables [data-table="payments"]')).toBeVisible();
  await waitForIdle(page);
  expect(asked).toHaveLength(1);
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

test("a pointer resting on a chip left from the last schema asks nothing ahead", async ({ page }) => {
  await page.clock.install();
  await gotoApp(page);
  const release = await holdRequests(page, tableList("warehouse"));
  await page.locator("#schema-select").selectOption("warehouse");
  const asked = recordRequests(page, dataWith("table", "orders"));
  await page.locator('#tables [data-table="orders"]').hover();
  await page.clock.runFor(1000);
  release();
  await expect(page.locator('#tables [data-table="carriers"]')).toBeVisible();
  await waitForIdle(page);
  expect(asked).toEqual([]);
});

test("a click asks again when the rows asked for on hover failed", async ({ page }) => {
  await gotoApp(page);
  let calls = 0;
  await page.route(dataWith("table", "orders"), (route) =>
    ++calls === 1 ? route.fulfill(problem(500, "database unavailable", "database_error")) : route.continue(),
  );
  const early = page.waitForResponse(dataWith("table", "orders"));
  await page.locator('#tables [data-table="orders"]').hover();
  await early;
  await selectTable(page, "orders");
  expect(calls).toBe(2);
});

test("a revisit to a table with a remembered sort takes its early rows", async ({ page }) => {
  await gotoApp(page, "?table=orders");
  await page.locator("thead th[data-col] .sort-btn").first().click();
  await waitForIdle(page);
  const asked = recordRequests(page, dataWith("table", "orders"));
  await gotoApp(page, "?table=orders");
  expect(asked).toHaveLength(1);
  expect(new URL(asked[0]).searchParams.get("sort")).not.toBeNull();
});

test("Prev asks for nothing ahead", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#next").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 2");
  const asked = recordRequests(page, tableData);
  await page.locator("#prev").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 1");
  expect(asked.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0"]);
});
