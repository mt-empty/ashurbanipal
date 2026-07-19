import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

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

test("toolbar chrome stays stable when the hidden-count indicator changes (screenshot)", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await page.locator("#columns-pop-list label", { hasText: "price" }).locator("input").uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator("#columns-pop")).toBeHidden();
  await expect(page.locator("#controls")).toHaveScreenshot("controls-hidden-column.png");
});
