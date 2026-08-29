import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

test("a table keeps the sort last chosen on it when you leave and come back", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");

  await selectTable(page, "users");
  await expect(page.locator('th[data-col="price"]')).toHaveCount(0);

  await selectTable(page, "products");
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
});

test("switching to a table that was never sorted carries no sort", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await waitForIdle(page);

  await selectTable(page, "orders");
  await expect(page.locator('thead th[data-col]:not([aria-sort="none"])')).toHaveCount(0);
});

test("a remembered sort column the backend rejects is dropped and the view recovers", async ({ page }) => {
  // Storage from before a schema change: `ghost_col` no longer exists, so
  // the first fetch 400s and loadData must retry unsorted (Option A / R11).
  await page.addInitScript(() => {
    localStorage.setItem(
      "ashurbanipal_ui",
      JSON.stringify({ table: "products", sortByTable: { products: { col: "ghost_col", order: "asc" } } }),
    );
  });
  await page.route("**/api/tables/data*", (r) => {
    if (new URL(r.request().url()).searchParams.get("sort") === "ghost_col") {
      return r.fulfill({ status: 400, body: 'unknown sort column "ghost_col"' });
    }
    return r.continue();
  });

  await gotoApp(page);
  await page.locator("#current").getByText("products", { exact: true }).waitFor();

  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
  await expect(page.locator('thead th[data-col]:not([aria-sort="none"])')).toHaveCount(0);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ashurbanipal_ui")!));
  expect(stored.sortByTable.products).toBeUndefined();
});
