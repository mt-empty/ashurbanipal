import { expect, type Page, test } from "./support/fixtures";
import { apiCall, gotoApp, holdRequests, problem, recordRequests, selectTable, waitForIdle } from "./support/helpers";
import { gotoJoin, joinQuery, joinRequest, nextJoinResponse, ORDERS_USERS } from "./support/join";

test("common-values dropdown is populated for a low-cardinality column", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('.common-values-btn[aria-label="common values for status"]').click();
  await expect(page.locator("#cv-pop")).toBeVisible();
  const values = page.locator("#cv-pop-list button.cv-value");
  await expect(values.first()).toBeVisible();
  const count = await values.count();
  expect(count).toBeGreaterThan(0);
  await expect(values.first().locator(".cv-freq")).toHaveText(/^\d+%$/);
  await expect(page.locator("#cv-pop-list .cv-note")).toHaveCount(0);
});

test("a column unique on its own offers no common-values button", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  // email has a unique constraint, id is the single-column primary key.
  await expect(page.locator('.common-values-btn[aria-label="common values for email"]')).toHaveCount(0);
  await expect(page.locator('.common-values-btn[aria-label="common values for id"]')).toHaveCount(0);
  await expect(page.locator('.common-values-btn[aria-label="common values for age"]')).toHaveCount(1);
});

test("an empty common-values answer dims that column's button", async ({ page }) => {
  await page.route("**/tables/common-values?*", (route) => route.fulfill({ json: { values: [] } }));
  await gotoApp(page);
  await selectTable(page, "orders");
  const btn = page.locator('.common-values-btn[aria-label="common values for status"]');
  await btn.click();
  await expect(page.locator("#cv-pop-list .cv-empty")).toHaveText("no common values available");
  await expect(page.locator("#cv-pop-list button.cv-value")).toHaveCount(0);
  await expect(btn).toHaveClass(/cv-none/);
  // Still dimmed after a sort redraws the header.
  await page.keyboard.press("Escape");
  await page.locator('th[data-col="total_cents"] .sort-btn').click();
  await expect(btn).toHaveClass(/cv-none/);
});

test("clicking a common value applies it as a filter", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('.common-values-btn[aria-label="common values for status"]').click();
  const firstValue = page.locator("#cv-pop-list button.cv-value").first();
  const value = await firstValue.locator("span").first().textContent();
  await firstValue.click();

  await expect(page.locator("#cv-pop")).toBeHidden();
  await expect(page.locator("#filter")).toHaveValue(`status = ${value}`);
  const statusCells = page.locator('#tbody td[data-col="status"] .cell-text');
  await expect
    .poll(async () => {
      const values = await statusCells.allTextContents();
      return values.length > 0 && values.every((v) => v === value);
    })
    .toBe(true);
});

const cvButton = (page: Page, name: string) =>
  page.locator(`.common-values-btn[aria-label=${JSON.stringify(`common values for ${name}`)}]`);
const COUNTS_LOCATIONS =
  "FROM inventory_counts c JOIN inventory_locations l ON c.warehouse_code = l.warehouse_code AND c.bin_code = l.bin_code";

test("a joined table's common values come from that table and filter the join", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  const asked = page.waitForRequest((r) => apiCall("/tables/common-values")(new URL(r.url())));
  await cvButton(page, "u.is_active").click();
  const params = new URL((await asked).url()).searchParams;
  expect([params.get("table"), params.get("column")]).toEqual(["users", "is_active"]);

  const firstValue = page.locator("#cv-pop-list button.cv-value").first();
  await expect(firstValue.locator(".cv-freq")).toHaveText(/^\d+%$/);
  await expect(page.locator("#cv-pop-list .cv-note")).toHaveText(
    "Shares of all rows in users, not indicative of this join",
  );
  const value = await firstValue.locator("span").first().textContent();
  const response = nextJoinResponse(page);
  await firstValue.click();
  const url = new URL((await response).url());
  expect(JSON.parse(url.searchParams.get("filter") as string)).toEqual([
    { column: "is_active", join: 1, op: "=", value },
  ]);
  await expect(page.locator("#filter")).toHaveValue(`u.is_active = ${value}`);
  await waitForIdle(page);
  await expect(page.locator("#error")).toBeEmpty();
  const cells = await page.locator('#tbody td[data-col="is_active"] .cell-text').allTextContents();
  expect(cells.length).toBeGreaterThan(0);
  expect(new Set(cells)).toEqual(new Set([value]));
});

test("each side of a self-join filters under its own alias", async ({ page }) => {
  const structure = recordRequests(page, (r) => apiCall("/tables/structure", { table: "orders" })(new URL(r.url())));
  await gotoJoin(page, "FROM orders a JOIN orders b ON a.user_id = b.user_id");
  await cvButton(page, "b.status").click();
  const firstValue = page.locator("#cv-pop-list button.cv-value").first();
  const value = await firstValue.locator("span").first().textContent();
  await firstValue.click();
  await expect(page.locator("#filter")).toHaveValue(`b.status = ${value}`);
  await waitForIdle(page);
  await expect(cvButton(page, "a.status")).toHaveCount(1);
  expect(structure).toHaveLength(1);
});

test("a quoted alias filters and suggests under its quoted name", async ({ page }) => {
  await gotoJoin(page, 'FROM orders "and" JOIN users u ON "and".user_id = u.id');
  await page.locator("#filter").fill('"and".status = ');
  await page.locator("#filter").focus();
  await expect(page.locator("#filter-suggest-list button").first()).toBeVisible();
  await page.locator("#filter").fill("");
  await cvButton(page, '"and".status').click();
  const firstValue = page.locator("#cv-pop-list button.cv-value").first();
  const value = await firstValue.locator("span").first().textContent();
  await firstValue.click();
  await expect(page.locator("#filter")).toHaveValue(`"and".status = ${value}`);
  await waitForIdle(page);
  await expect(page.locator("#error")).toBeEmpty();
});

test("in a join, uniqueness is decided per source table", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  for (const name of ["o.id", "u.id", "u.email"]) await expect(cvButton(page, name)).toHaveCount(0);
  for (const name of ["o.status", "o.user_id", "u.age"]) await expect(cvButton(page, name)).toHaveCount(1);

  // Each table's single-column pk is hidden; every member of a composite one is not.
  await gotoJoin(page, COUNTS_LOCATIONS);
  await expect(cvButton(page, "c.id")).toHaveCount(0);
  await expect(cvButton(page, "l.warehouse_code")).toHaveCount(1);
  await expect(cvButton(page, "l.bin_code")).toHaveCount(1);

  // A select list keeping one member of a composite pk does not make it unique.
  await gotoJoin(page, `SELECT l.warehouse_code ${COUNTS_LOCATIONS}`);
  await expect(cvButton(page, "l.warehouse_code")).toHaveCount(1);
});

test("a join's pk shows no button until its table's facts say it may", async ({ page }) => {
  const release = await holdRequests(page, apiCall("/tables/structure"));
  await gotoJoin(page, COUNTS_LOCATIONS);
  await expect(cvButton(page, "c.quantity")).toHaveCount(1);
  await expect(cvButton(page, "c.id")).toHaveCount(0);
  await expect(cvButton(page, "l.warehouse_code")).toHaveCount(0);
  release();
  await expect(cvButton(page, "l.warehouse_code")).toHaveCount(1);
  await expect(cvButton(page, "c.id")).toHaveCount(0);
});

test("a join asks about its tables only once its rows are back", async ({ page }) => {
  const lookups = recordRequests(page, (r) => {
    const url = new URL(r.url());
    return apiCall("/tables/structure")(url) || apiCall("/tables/referenced-by")(url);
  });
  let sentBeforeJoin = -1;
  await page.route(joinRequest, (route) => {
    sentBeforeJoin = lookups.length;
    return route.continue();
  });
  await gotoApp(page, joinQuery(ORDERS_USERS));
  expect(sentBeforeJoin).toBe(0);
  await expect(cvButton(page, "u.age")).toHaveCount(1);
  await expect.poll(() => lookups.length).toBe(4);
});

test("a join that fails asks nothing about its tables", async ({ page }) => {
  const lookups = recordRequests(page, (r) => apiCall("/tables/structure")(new URL(r.url())));
  await page.route(joinRequest, (route) => route.fulfill(problem(400, "invalid join", "invalid_join")));
  await gotoApp(page, joinQuery(ORDERS_USERS));
  await waitForIdle(page);
  expect(lookups).toEqual([]);
});

test("a failed structure lookup leaves the join usable", async ({ page }) => {
  await page.route(
    (url) => apiCall("/tables/structure")(url),
    (route) => route.fulfill(problem(500, "boom", "internal")),
  );
  await gotoJoin(page, ORDERS_USERS);
  await expect(page.locator("#error")).toBeEmpty();
  await expect(cvButton(page, "u.age")).toHaveCount(1);
  await cvButton(page, "u.age").click();
  await expect(page.locator("#cv-pop")).toBeVisible();
});

test("typing a join column's name offers its source table's values", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  const labels = page.locator("#filter-suggest-list button");
  await page.locator("#filter").fill("u.is_active = ");
  await expect(labels.filter({ hasText: /^(true|false|t|f)$/ }).first()).toBeVisible();
  // A plain name is the start table's column.
  await page.locator("#filter").fill("status = ");
  await expect(labels.filter({ hasText: "completed" })).toHaveCount(1);
  await page.locator("#filter").fill("o.status = ");
  await expect(labels.filter({ hasText: "completed" })).toHaveCount(1);
  // users has no status; nothing to look up.
  await page.locator("#filter").fill("u.status = ");
  await expect(page.locator("#filter-suggest")).toBeHidden();
});
