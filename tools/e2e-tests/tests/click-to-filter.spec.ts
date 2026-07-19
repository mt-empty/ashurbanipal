import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

test("clicking a cell's filter button composes and submits an exact-match filter", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstStatusCell = page.locator('#tbody tr').first().locator('td[data-col="status"]');
  const value = await firstStatusCell.locator(".cell-text").textContent();
  await firstStatusCell.hover();
  await firstStatusCell.locator(".filter-eq").click();

  await expect(page.locator("#filter")).toHaveValue(`status = ${value}`);
  const statusCells = page.locator('#tbody td[data-col="status"] .cell-text');
  await expect
    .poll(async () => {
      const values = await statusCells.allTextContents();
      return values.length > 0 && values.every((v) => v === value);
    })
    .toBe(true);
});

test("clicking a null cell's filter button composes IS NULL", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const nullAgeButton = page
    .locator('#tbody td[data-col="age"] button.filter-eq.only-action')
    .first();
  await expect(nullAgeButton).toHaveAttribute("aria-label", "filter by null");
  await nullAgeButton.hover();
  await nullAgeButton.click();

  await expect(page.locator("#filter")).toHaveValue("age IS NULL");
  const ageCells = page.locator('#tbody td[data-col="age"] .cell-text');
  await expect
    .poll(async () => {
      const values = await ageCells.allTextContents();
      return values.length > 0 && values.every((v) => v === "∅");
    })
    .toBe(true);
});

test("a value containing a space is quoted in the composed filter", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  // Product names are "<buzzword> <noun>" (tools/seed-gen) — always
  // multi-word, so the first row is guaranteed to exercise quoting.
  const firstNameCell = page.locator('#tbody tr').first().locator('td[data-col="name"]');
  const value = await firstNameCell.locator(".cell-text").textContent();
  expect(value).toContain(" ");
  await firstNameCell.hover();
  await firstNameCell.locator(".filter-eq").click();

  await expect(page.locator("#filter")).toHaveValue(`name = '${value}'`);
  await expect(page.locator("#error")).toBeEmpty();
  const nameCells = page.locator('#tbody td[data-col="name"] .cell-text');
  await expect
    .poll(async () => {
      const values = await nameCells.allTextContents();
      return values.length > 0 && values.every((v) => v === value);
    })
    .toBe(true);
});
