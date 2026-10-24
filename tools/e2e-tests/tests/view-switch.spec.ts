import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, problem, selectTable, tableKey, uiState, waitForIdle } from "./support/helpers";

// The suite's one spec with real view-transition fades, so waitForIdle's animation wait stays exercised.
test.use({ realFades: true });

const DATA = "**/api/tables/data*";
const param = (url: string, name: string) => new URL(url).searchParams.get(name);

/** Holds the data responses that match until the returned function is called. */
async function holdData(page: Page, matches: (url: string) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(DATA, async (route) => {
    if (matches(route.request().url())) await gate;
    await route.continue();
  });
  return release;
}

const failData = (page: Page, matches: (url: string) => boolean) =>
  page.route(DATA, (route) =>
    matches(route.request().url()) ? route.fulfill(problem(503, "Service Unavailable", "database_error")) : route.continue(),
  );

// The cursor of whatever the pointer would hit over the first data cell.
const cursorOverCell = (page: Page) =>
  page.evaluate(() => {
    const r = (document.querySelector("#tbody td[data-col]") as HTMLElement).getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as Element;
    return getComputedStyle(hit).cursor;
  });

const isLocked = (page: Page) => page.evaluate(() => (document.getElementById("data-table") as HTMLElement).inert);

test("while a chip's table loads, the old grid's columns menu still changes the old table", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const release = await holdData(page, (url) => param(url, "table") === "orders");
  const sent = page.waitForRequest((r) => r.url().includes("/api/tables/data") && param(r.url(), "table") === "orders");
  await page.locator('#tables [data-table="orders"]').click();
  await sent;

  await page.locator("#columns-btn").click();
  await page.locator('#columns-pop-list label[data-name="price"] input').uncheck();
  await expect(page.locator('th[data-col="price"]')).toHaveClass(/col-hidden/);
  const stored = (await uiState(page)).hiddenColumns;
  expect(stored[tableKey("products")]).toEqual(["price"]);
  expect(stored[tableKey("orders")]).toBeUndefined();
  await page.keyboard.press("Escape");

  release();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="status"]')).toBeVisible();
});

test("a chip whose table fails to load leaves the view where it was and names the table", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await failData(page, (url) => param(url, "table") === "orders");
  await page.locator('#tables [data-table="orders"]').click();

  await expect(page.locator("#error")).toHaveText("Couldn't open orders: Service Unavailable");
  await expect(page.locator("#current")).toHaveText("products");
  await expect(page.locator('#tables [data-table="products"]')).toHaveClass(/active/);
  expect(new URL(page.url()).searchParams.get("table")).toBe("products");
  expect(await isLocked(page)).toBe(false);

  const retried = page.waitForRequest((r) => r.url().includes("/api/tables/data"));
  await page.locator("#refresh").click();
  expect(param((await retried).url(), "table")).toBe("products");
});

test("a chip's remembered sort the backend refuses is dropped and the table opens unsorted", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      "ashurbanipal_ui",
      JSON.stringify({ table: "products", sortByTable: { [key]: { col: "ghost_col", order: "asc" } } }),
    );
  }, tableKey("orders"));
  await page.route(DATA, (route) =>
    param(route.request().url(), "sort") === "ghost_col"
      ? route.fulfill(problem(400, 'not allowed: column "ghost_col"', "unknown_column"))
      : route.continue(),
  );
  await gotoApp(page);
  await selectTable(page, "orders");

  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator('thead th[data-col]:not([aria-sort="none"])')).toHaveCount(0);
  expect((await uiState(page)).sortByTable[tableKey("orders")]).toBeUndefined();
});

test("an FK cell whose table fails to load leaves the view and the filter box as they were", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await failData(page, (url) => param(url, "table") === "users");
  await page.locator("#tbody tr").first().locator('td[data-col="user_id"] .fk-cell').click();

  await expect(page.locator("#error")).toHaveText("Couldn't open users: Service Unavailable");
  await expect(page.locator("#current")).toHaveText("orders");
  await expect(page.locator("#filter")).toHaveValue("");
});

test("a schema switch whose first load fails leaves the old grid locked until a grid renders", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await failData(page, (url) => param(url, "schema") === "warehouse");
  await page.locator("#schema-select").selectOption("warehouse");

  await expect(page.locator("#error")).toHaveText("Couldn't open carriers: Service Unavailable");
  await expect(page.locator("#data-table")).toHaveAttribute("data-stale", "");
  expect(await isLocked(page)).toBe(true);
  expect(await cursorOverCell(page)).toBe("not-allowed");
  await expect(page.locator("#columns-btn")).toBeDisabled();
  await expect(page.locator("#structure-btn")).toBeDisabled();
  await expect(page.locator("#next")).toBeDisabled();

  // The grid's view is not the one in the state, so a failed chip names its table too.
  await page.locator('#tables [data-table="carriers"]').click();
  await expect(page.locator("#error")).toHaveText("Couldn't open carriers: Service Unavailable");

  const back = page.waitForResponse((r) => r.url().includes("/api/tables/data") && param(r.url(), "schema") === "public");
  await page.locator("#schema-select").selectOption("public");
  await back;
  await waitForIdle(page);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-stale");
  expect(await isLocked(page)).toBe(false);
  expect(await cursorOverCell(page)).not.toBe("not-allowed");
  await expect(page.locator("#columns-btn")).toBeEnabled();
  await expect(page.locator("#structure-btn")).toBeEnabled();
});

test("Back locks the old grid while the earlier table loads, and unlocks once it renders", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  const release = await holdData(page, (url) => param(url, "table") === "users");
  const sent = page.waitForRequest((r) => r.url().includes("/api/tables/data") && param(r.url(), "table") === "users");
  await page.locator("#nav-back").click();
  await sent;

  await expect(page.locator("#data-table")).toHaveAttribute("data-stale", "");
  await expect(page.locator("#columns-btn")).toBeDisabled();

  release();
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-stale");
  await expect(page.locator("#columns-btn")).toBeEnabled();
});

test("a locked grid's all-hidden Show all cannot change the view that replaced it", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await page.getByRole("button", { name: "hide all products columns" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#all-hidden-show")).toBeEnabled();

  await failData(page, (url) => param(url, "schema") === "warehouse");
  await page.locator("#schema-select").selectOption("warehouse");
  await expect(page.locator("#data-table")).toHaveAttribute("data-stale", "");
  await expect(page.locator("#all-hidden-show")).toBeDisabled();
  await expect(page.locator("#sort-note-show")).toBeDisabled();
});

test("a cross-schema FK cell opens its table from the first page", async ({ page }) => {
  await gotoApp(page);
  const schemaLoaded = page.waitForResponse((r) => r.url().includes("/api/tables/data") && param(r.url(), "schema") === "warehouse");
  await page.locator("#schema-select").selectOption("warehouse");
  await schemaLoaded;
  await waitForIdle(page);
  await selectTable(page, "shipments");
  await page.locator("#next").click();
  await waitForIdle(page);

  const offsets: (string | null)[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/tables/data") && param(r.url(), "table") === "orders") offsets.push(param(r.url(), "offset"));
  });
  await page.locator("#tbody tr").first().locator('td[data-col="order_id"] .fk-cell').click();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await waitForIdle(page);
  expect(offsets.length).toBeGreaterThan(0);
  expect(offsets.every((o) => o === "0")).toBe(true);
});
