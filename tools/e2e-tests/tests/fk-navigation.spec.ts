import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

test("clicking an FK cell switches table and filters to the matching row", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstFkCell = page.locator('#tbody tr').first().locator('td[data-col="user_id"] .fk-cell');
  const userId = await firstFkCell.textContent();
  await firstFkCell.click();

  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue(`id = ${userId}`);
  const idCells = page.locator('#tbody td[data-col="id"] .cell-text');
  await expect
    .poll(async () => {
      const values = await idCells.allTextContents();
      return values.length > 0 && values.every((v) => v === userId);
    })
    .toBe(true);
});

test("a null FK cell has no navigation affordance", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "events");
  const nullUserIdCell = page
    .locator('#tbody td[data-col="user_id"]')
    .filter({ has: page.locator(".cell-text", { hasText: "∅" }) })
    .first();
  await expect(nullUserIdCell.locator(".cell-text")).not.toHaveClass(/fk-cell/);
  // Null cells render a plain <span>, not a <button> — nothing to click at all.
  await expect(nullUserIdCell.locator("button.cell-text")).toHaveCount(0);

  await nullUserIdCell.locator(".cell-text").click();
  await expect(page.locator("#current")).toHaveText("events");
});

test("a column that is both PK and FK shows both facts and navigates like an FK", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "order_extra");
  await expect(page.locator('th[data-col="order_id"] .key-icon')).toHaveAttribute(
    "title",
    "primary key, also references orders.id",
  );
  const firstCell = page.locator("#tbody tr").first().locator('td[data-col="order_id"] .fk-cell');
  const orderId = await firstCell.textContent();
  await firstCell.click();

  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue(`id = ${orderId}`);
});
