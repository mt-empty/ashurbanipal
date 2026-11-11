import { expect, type Page, test } from "./support/fixtures";
import { apiCall, gotoApp, selectTable } from "./support/helpers";

// The e2e backend is Postgres. These specs relabel its real sources, keeping
// their names, so the scoped requests that follow still resolve.
async function reportEngine(page: Page, engine: string) {
  await page.route(apiCall("/sources"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const source of body.sources) source.engine = engine;
    await route.fulfill({ response, json: body });
  });
  // No estimate yet, as SQLite always answers and Postgres before ANALYZE.
  await page.route(apiCall("/table-counts"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const count of body.counts) count.approx_rows = -1;
    await route.fulfill({ response, json: body });
  });
  await page.route(apiCall("/tables/data"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.total_approx = -1;
    await route.fulfill({ response, json: body });
  });
}

async function openJoinTablePicker(page: Page) {
  await page.locator("#join-btn").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await page.getByRole("button", { name: "join 1 table", exact: true }).click();
}

const usersOption = (page: Page) => page.locator('#dd-pop .dd-row[data-value="users"]');

test("a SQLite source shows no table counts anywhere", async ({ page }) => {
  await reportEngine(page, "sqlite");
  await gotoApp(page);
  await selectTable(page, "orders");

  const chip = page.locator('#tables a[data-table="users"]');
  await expect(chip.locator(".count")).toHaveText("");
  await expect(chip.locator(".count")).toHaveClass(/\bnone\b/);
  await expect(page.locator("#row-meta")).not.toContainText("rows");
  await expect(page.locator("#row-meta")).toContainText("columns");

  await openJoinTablePicker(page);
  await expect(usersOption(page)).toBeVisible();
  await expect(usersOption(page).locator(".dd-note")).toHaveCount(0);
});

test("a Postgres table with no estimate yet still shows ?", async ({ page }) => {
  await reportEngine(page, "postgres");
  await gotoApp(page);
  await selectTable(page, "orders");

  await expect(page.locator('#tables a[data-table="users"] .count')).toHaveText("?");
  await expect(page.locator("#row-meta")).toContainText("? rows");

  await openJoinTablePicker(page);
  await expect(usersOption(page).locator(".dd-note")).toHaveText("?");
});
