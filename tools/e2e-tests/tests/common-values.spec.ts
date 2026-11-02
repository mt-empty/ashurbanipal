import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";

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
