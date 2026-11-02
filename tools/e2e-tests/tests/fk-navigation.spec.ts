import { expect, test } from "./support/fixtures";
import { dataWith, gotoApp, selectTable, waitForIdle, waitForTable } from "./support/helpers";

test("clicking an FK cell switches table and filters to the matching row", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstFkCell = page.locator("#tbody tr").first().locator('td[data-col="user_id"] .fk-cell');
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

// warehouse.shipments.order_id references public.orders(id) — the seed's
// one cross-schema FK (spec/protocol.md's references.schema, present only
// when the referenced table lives in a different schema than the column).
test("clicking a cross-schema FK cell switches schema, table, and filters to the matching row", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("#schema-select-wrap")).toBeVisible();

  const schemaLoaded = page.waitForResponse((r) => dataWith("schema", "warehouse")(r) && r.ok());
  await page.locator("#schema-select").selectOption("warehouse");
  await schemaLoaded;
  await waitForIdle(page);

  await selectTable(page, "shipments");
  const firstFkCell = page.locator("#tbody tr").first().locator('td[data-col="order_id"] .fk-cell');
  const orderId = await firstFkCell.textContent();
  await firstFkCell.click();

  await waitForTable(page, "orders");
  await expect(page.locator("#schema-select")).toHaveValue("public");
  await expect(page.locator("#filter")).toHaveValue(`id = ${orderId}`);
  const idCells = page.locator('#tbody td[data-col="id"] .cell-text');
  await expect
    .poll(async () => {
      const values = await idCells.allTextContents();
      return values.length > 0 && values.every((v) => v === orderId);
    })
    .toBe(true);
});

test("a composite foreign key links each member cell with every column pair", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "inventory_counts");
  const icon = page.locator('th[data-col="bin_code"] .key-icon');
  await expect(icon).toHaveAttribute(
    "title",
    "part of foreign key (warehouse_code, bin_code) → inventory_locations(warehouse_code, bin_code)",
  );
  const row = page.locator("#tbody tr").first();
  const warehouse = await row.locator('td[data-col="warehouse_code"] .cell-text').textContent();
  const bin = await row.locator('td[data-col="bin_code"] .cell-text').textContent();
  await row.locator('td[data-col="bin_code"] .fk-cell').click();

  await waitForTable(page, "inventory_locations");
  await expect(page.locator("#filter")).toHaveValue(`warehouse_code = ${warehouse} AND bin_code = ${bin}`);
  await expect(page.locator("#tbody tr")).toHaveCount(1);
});
