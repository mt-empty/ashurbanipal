import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

test("clicking an unsorted column sorts it ascending", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
});

test("clicking the same column again toggles to descending", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const priceHeader = page.locator('th[data-col="price"]');
  await priceHeader.click();
  await expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  await priceHeader.click();
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
  await expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  await priceHeader.click(); // now descending
  await expect(priceHeader).toHaveAttribute("aria-sort", "descending");

  await categoryHeader.click();
  await expect(categoryHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(priceHeader).toHaveAttribute("aria-sort", "none");
});

test("ascending sort actually reorders rows by value", async ({ page }) => {
  // Known bug, not yet fixed: db.rs's unqualified `order by` resolves to
  // the ::text-cast output column instead of the real numeric column, so
  // this sorts lexicographically ("107.92" < "11.18") instead of
  // numerically. See docs/known-issues.md #1 for root cause + the fix.
  // Pinned to correct behavior on purpose — once fixed, this test starts
  // "unexpectedly passing," which is the signal to delete this line.
  test.fail(true, "known bug: docs/known-issues.md #1 — sort is lexicographic, not numeric");
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
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
  await page.locator('th[data-col="category"]').click();
  await expect(page.locator("thead tr")).toHaveScreenshot("sort-header-row.png");
});
