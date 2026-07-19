import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

test("clicking an unsorted column sorts it ascending", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
});

test("clicking the same column again toggles to descending", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const priceHeader = page.locator('th[data-col="price"]');
  await priceHeader.click();
  await waitForIdle(page);
  await expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  await priceHeader.click();
  await waitForIdle(page);
  await expect(priceHeader).toHaveAttribute("aria-sort", "descending");
});

test("switching to a different column always starts ascending, and unsorts the old column", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const priceHeader = page.locator('th[data-col="price"]');
  const categoryHeader = page.locator('th[data-col="category"]');
  await priceHeader.click();
  await waitForIdle(page);
  await expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  await priceHeader.click(); // now descending
  await waitForIdle(page);
  await expect(priceHeader).toHaveAttribute("aria-sort", "descending");

  await categoryHeader.click();
  await waitForIdle(page);
  await expect(categoryHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(priceHeader).toHaveAttribute("aria-sort", "none");
});

test("ascending sort actually reorders rows by value", async ({ page }) => {
  // Regression test for docs/known-issues.md #1 (fixed): db.rs's
  // unqualified `order by` used to resolve to the ::text-cast output
  // column instead of the real numeric column, sorting lexicographically
  // ("107.92" < "11.18") instead of numerically.
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");

  const priceCells = page.locator('#tbody td[data-col="price"] .cell-text');
  const values = await priceCells.allTextContents();
  const numbers = values.map(Number);
  const sorted = [...numbers].sort((a, b) => a - b);
  expect(numbers).toEqual(sorted);
});

test("header row width stays stable when the sort target switches (screenshot)", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
  await page.locator('th[data-col="category"]').click();
  await waitForIdle(page);
  await expect(page.locator('th[data-col="category"]')).toHaveAttribute("aria-sort", "ascending");
  // The header row (~1770px) is wider than the viewport, and #main only
  // resets vertical scroll on load (loadData()'s scrollTo), not horizontal
  // — so a prior action's leftover scrollLeft would otherwise make this
  // screenshot's visible crop nondeterministic. Pin it to 0 explicitly.
  await page.locator("#main").evaluate((el) => (el.scrollLeft = 0));
  await expect(page.locator("thead tr")).toHaveScreenshot("sort-header-row.png");
});
