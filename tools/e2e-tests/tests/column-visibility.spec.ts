import { test, expect, type Page } from "./support/fixtures";
import { applyFilter, dataWith, failRequests, gotoApp, selectTable, tableKey, tableList, uiState, waitForIdle } from "./support/helpers";
import { gotoJoin, ORDERS_USERS } from "./support/join";

const menuItem = (page: Page, name: string) => page.locator(`#columns-pop-list label[data-name="${name}"]`);

test("hiding a column removes it from the grid and updates the hidden-count indicator", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await expect(page.locator("#columns-btn")).toHaveText("columns");

  await page.locator("#columns-btn").click();
  await page.locator("#columns-pop-list label", { hasText: "price" }).locator("input").uncheck();

  await expect(page.locator("#columns-btn")).toHaveText("columns (1 hidden)");
  await expect(page.locator('th[data-col="price"]')).toHaveClass(/col-hidden/);
  const priceCells = page.locator('td[data-col="price"]');
  const count = await priceCells.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(priceCells.nth(i)).toHaveClass(/col-hidden/);
  }
  await expect(page.locator('th[data-col="sku"]')).not.toHaveClass(/col-hidden/);
});

test("hiding a column is scoped per-table", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await page.locator("#columns-pop-list label", { hasText: "id" }).locator("input").uncheck();
  await expect(page.locator('th[data-col="id"]')).toHaveClass(/col-hidden/);

  await selectTable(page, "orders");
  await expect(page.locator('th[data-col="id"]')).not.toHaveClass(/col-hidden/);

  await selectTable(page, "products");
  await expect(page.locator('th[data-col="id"]')).toHaveClass(/col-hidden/);
});

test("a header name is a button, so the keyboard sorts and focus stays on it", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const name = page.locator('th[data-col="price"] .sort-btn');
  await name.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
  await waitForIdle(page);
  await expect(name).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "descending");
});

test("an auto-refresh tick keeps focus on the columns menu checkbox", async ({ page }) => {
  await page.clock.install();
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#refresh-menu-btn").click();
  await page.getByRole("radio", { name: "5 s", exact: true }).check();
  await page.locator("#columns-btn").click();
  const box = menuItem(page, "sku").locator("input");
  await box.focus();

  const tick = page.waitForResponse("**/api/tables/data*");
  await page.clock.fastForward(5000);
  await tick;
  await waitForIdle(page);
  await expect(page.locator("#columns-pop")).toBeVisible();
  await expect(box).toBeFocused();
});

test("a stored hidden column the table no longer has is not counted and is dropped", async ({ page }) => {
  const key = tableKey("orders");
  await page.addInitScript((k) => {
    localStorage.setItem("ashurbanipal_view", JSON.stringify({ table: "orders", hiddenColumns: { [k]: ["ghost_col", "status"] } }));
  }, key);
  await gotoApp(page);
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#columns-btn")).toHaveText("columns (1 hidden)");
  await expect(page.locator('th[data-col="status"]')).toHaveClass(/col-hidden/);
  expect((await uiState(page)).hiddenColumns[key]).toEqual(["status"]);
});

test("hidden columns stay with their schema: a same-named table elsewhere is unaffected", async ({ page }) => {
  // The seed has no table name in two schemas, so `warehouse` is given a
  // `users` that serves public.users' rows; the keying is the frontend's alone.
  await page.route(
    tableList("warehouse"),
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { tables: [...json.tables, { name: "users" }] } });
    },
  );
  await page.route("**/api/tables/data*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("schema") !== "warehouse" || url.searchParams.get("table") !== "users") {
      return route.continue();
    }
    url.searchParams.set("schema", "public");
    await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });

  await gotoApp(page);
  await selectTable(page, "users");
  await page.locator("#columns-btn").click();
  await menuItem(page, "id").locator("input").uncheck();
  await page.keyboard.press("Escape");

  const other = page.waitForResponse((r) => dataWith("schema", "warehouse")(r) && r.ok());
  await page.locator("#schema-select").selectOption("warehouse");
  await other;
  await waitForIdle(page);
  await selectTable(page, "users");
  await expect(page.locator('th[data-col="id"]')).not.toHaveClass(/col-hidden/);
  await expect(page.locator("#columns-btn")).toHaveText("columns");

  const back = page.waitForResponse((r) => dataWith("schema", "public")(r) && r.ok());
  await page.locator("#schema-select").selectOption("public");
  await back;
  await waitForIdle(page);
  await selectTable(page, "users");
  await expect(page.locator('th[data-col="id"]')).toHaveClass(/col-hidden/);
  expect(Object.keys((await uiState(page)).hiddenColumns)).toEqual([tableKey("users")]);
});

test("a join shows plain column names and groups the menu by table", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  const usersId = page.locator('thead th[data-join="1"] .sort-btn').first();
  await expect(usersId).toHaveText("id");
  await expect(usersId).toHaveAttribute("title", "u.id");

  await page.locator("#columns-btn").click();
  await expect(page.locator("#columns-pop-list .cols-pill")).toHaveText(["orders o", "users u"]);
  const first = page.locator('.cols-group[data-band="1"] label').first();
  await expect(first).toHaveText("id");
  await expect(first.locator("input")).toHaveAttribute("aria-label", "u.id");
});

test("none and all on a join heading hide and show that table's columns and band", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.locator("#columns-btn").click();
  const users = page.locator('.cols-group[data-band="1"]');
  await page.getByRole("button", { name: "hide all users u columns" }).click();
  await expect(page.locator('th.band[data-band="1"]')).toHaveClass(/col-hidden/);
  await expect(users.locator(".cols-count")).toHaveText(/^0 of \d+$/);
  await expect(page.locator("#row-meta")).toHaveText(/ · (\d+) of (\d+) columns$/);

  await page.getByRole("button", { name: "show all users u columns" }).click();
  await expect(page.locator('th.band[data-band="1"]')).not.toHaveClass(/col-hidden/);
  await expect(users.locator(".cols-count")).toHaveText(/^(\d+) of \1$/);
  await expect(page.locator("#row-meta")).toHaveText(/ · \d+ columns$/);
  await expect(page.locator("#columns-btn")).toHaveText("columns");
});

test("hiding every column says so, and Show all brings them back", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await page.getByRole("button", { name: "hide all products columns" }).click();
  await expect(page.locator("#all-hidden-text")).toHaveText(/^All \d+ columns are hidden\.$/);
  await expect(page.locator("#row-meta")).toHaveText(/ · 0 of \d+ columns$/);

  await page.keyboard.press("Escape");
  await page.locator("#all-hidden-show").click();
  await expect(page.locator("#all-hidden")).toBeHidden();
  await expect(page.locator("#columns-btn")).toHaveText("columns");
  await expect(page.locator('th[data-col="price"]')).not.toHaveClass(/col-hidden/);
});

test("the header line names the sort, and offers to show the column once it is hidden", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await expect(page.locator("#sort-note")).toBeHidden();
  await page.locator('th[data-col="price"] .sort-btn').click();
  await waitForIdle(page);
  await expect(page.locator("#sort-note")).toHaveText(/^ · sorted by price ↑ /);
  await expect(page.locator("#sort-note-show")).toBeHidden();
  await page.locator("#columns-btn").click();
  await expect(menuItem(page, "price").locator(".cols-sorted")).toHaveText("sorted ↑");

  await menuItem(page, "price").locator("input").uncheck();
  await expect(page.locator("#sort-note-show")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#sort-note-show").click();
  await expect(page.locator('th[data-col="price"]')).not.toHaveClass(/col-hidden/);
  await expect(page.locator("#sort-note")).toBeVisible();
  await expect(page.locator("#sort-note-show")).toBeHidden();
});

test("in a join the header line names the sort as alias.column", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.locator('thead th[data-join="1"] .sort-btn').first().click();
  await waitForIdle(page);
  await expect(page.locator("#sort-note-col")).toHaveText("u.id");
});

test("an empty result's row still spans the header after a column is shown again", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await menuItem(page, "price").locator("input").uncheck();
  await page.keyboard.press("Escape");
  await applyFilter(page, "price < 0");
  await expect(page.locator("#tbody tr.empty")).toBeVisible();

  await page.locator("#columns-btn").click();
  await menuItem(page, "price").locator("input").check();
  const widths = () =>
    page.evaluate(() =>
      [
        document.querySelector("#tbody tr.empty td") as HTMLElement,
        document.querySelector("#thead tr:last-child") as HTMLElement,
      ].map((e) => Math.round(e.getBoundingClientRect().width)),
    );
  await expect.poll(async () => new Set(await widths()).size).toBe(1);
});

// A table whose load fails leaves the previous grid on screen while state.view has moved on.
const failTableLoad = (page: Page, table: string) => failRequests(page, dataWith("table", table));

test("a toggle on a grid left by a failed load changes only that column", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await menuItem(page, "sku").locator("input").uncheck();
  await page.keyboard.press("Escape");

  await failTableLoad(page, "orders");
  await page.locator('#tables [data-table="orders"]').click();
  await expect(page.locator("#error")).not.toBeEmpty();
  await page.locator("#columns-btn").click();
  await menuItem(page, "price").locator("input").uncheck();
  await expect(page.locator('th[data-col="price"]')).toHaveClass(/col-hidden/);
  await expect(page.locator('th[data-col="sku"]')).toHaveClass(/col-hidden/);
  const stored = (await uiState(page)).hiddenColumns;
  expect(stored[tableKey("products")]).toEqual(["sku", "price"]);
  expect(stored[tableKey("orders")]).toBeUndefined();
});

test("the record dialog of a join grid left by a failed load keeps its table groups", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await failTableLoad(page, "products");
  await page.locator('#tables [data-table="products"]').click();
  await expect(page.locator("#error")).not.toBeEmpty();
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dl dt.record-group")).toHaveText(["orders o", "users u"]);
  await expect(page.locator("#record-dl dt", { hasText: /^id$/ }).last()).toHaveAttribute("title", "u.id");
});

test("a schema with no tables clears the sort note and the all-hidden message", async ({ page }) => {
  await page.route("**/api/tables*", (route) =>
    new URL(route.request().url()).searchParams.get("schema") === "warehouse"
      ? route.fulfill({ json: { tables: [] } })
      : route.continue(),
  );
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"] .sort-btn').click();
  await waitForIdle(page);
  await page.locator("#columns-btn").click();
  await page.getByRole("button", { name: "hide all products columns" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sort-note")).toBeVisible();
  await expect(page.locator("#all-hidden")).toBeVisible();

  const listed = page.waitForResponse(tableList("warehouse"));
  await page.locator("#schema-select").selectOption("warehouse");
  await listed;
  await expect(page.locator("#current")).toHaveText("—");
  await expect(page.locator("#sort-note")).toBeHidden();
  await expect(page.locator("#all-hidden")).toBeHidden();
});
