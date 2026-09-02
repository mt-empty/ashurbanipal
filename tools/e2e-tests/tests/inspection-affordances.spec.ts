import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, applyFilter } from "./support/helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("payload dialog shows the raw JSON response and closes via its close button", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#payload").click();
  await expect(page.locator("#payload-dialog")).toBeVisible();
  const payloadText = await page.locator("#payload-pre").textContent();
  const parsed = JSON.parse(payloadText!);
  expect(Array.isArray(parsed.columns)).toBe(true);
  expect(Array.isArray(parsed.rows)).toBe(true);

  await page.locator('#payload-dialog button[aria-label="close"]').click();
  await expect(page.locator("#payload-dialog")).toBeHidden();
});

test("payload dialog also closes on Escape", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#payload").click();
  await expect(page.locator("#payload-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#payload-dialog")).toBeHidden();
});

test("cell preview popover pretty-prints a large nested jsonb value and light-dismisses", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "payments");
  await applyFilter(page, "status = failed");
  const cell = page.locator('#tbody tr').first().locator('td[data-col="gateway_response"] .cell-text');
  await cell.click();

  await expect(page.locator("#cell-pop")).toBeVisible();
  await expect(page.locator("#cell-pre")).toBeHidden();
  const cellJson = page.locator("#cell-json");
  await expect(cellJson).toBeVisible();
  const keys = await cellJson.locator(".json-key").allTextContents();
  expect(keys).toContain('"gateway"');
  expect(keys).toContain('"risk"');

  await page.locator("#current").click();
  await expect(page.locator("#cell-pop")).toBeHidden();
});

test("per-cell copy button copies the cell's value to the clipboard", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstStatusCell = page.locator('#tbody tr').first().locator('td[data-col="status"]');
  const value = await firstStatusCell.locator(".cell-text").textContent();
  await firstStatusCell.hover();
  await firstStatusCell.locator(".copy").click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(value);
});

test("record view lists every column as dt/dd, and per-field copy works", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator('#tbody tr').first();
  const statusValue = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  await firstRow.locator('.record-btn').click();

  await expect(page.locator("#record-dialog")).toBeVisible();
  const columnNames = ["id", "user_id", "status", "total_cents", "discount_pct", "tags", "line_items", "created_at"];
  await expect(page.locator("#record-dl dt")).toHaveText(columnNames);

  const statusDt = page.locator("#record-dl dt", { hasText: /^status$/ });
  const statusDd = statusDt.locator("xpath=following-sibling::dd[1]");
  await expect(statusDd).toHaveText(statusValue!);
  const statusCopyBtn = statusDd.locator("xpath=following-sibling::button[1]");
  await statusCopyBtn.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(statusValue);
});

test("record view's whole-row copy button copies the full row as JSON", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator('#tbody tr').first();
  const statusValue = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  await page.locator("#record-copy-row").click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clipboard);
  expect(parsed.status).toBe(statusValue);
  expect(Object.keys(parsed)).toEqual([
    "id", "user_id", "status", "total_cents", "discount_pct", "tags", "line_items", "created_at",
  ]);
});

test("record view's INSERT copy button copies the row as a SQL INSERT", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator("#tbody tr").first();
  const id = await firstRow.locator('td[data-col="id"] .cell-text').textContent();
  const status = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  const totalCents = await firstRow.locator('td[data-col="total_cents"] .cell-text').textContent();
  const discountPct = await firstRow.locator('td[data-col="discount_pct"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  await page.locator("#record-copy-insert").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("INSERT INTO ");
  const sql = await page.evaluate(() => navigator.clipboard.readText());

  // The e2e demo has multiple schemas, so the table name is schema-qualified.
  expect(sql).toMatch(
    /^INSERT INTO (public\.)?orders \(id, user_id, status, total_cents, discount_pct, tags, line_items, created_at\)\nVALUES \(/,
  );
  expect(sql).toContain(`'${id}'`);
  expect(sql).toContain(`'${status}'`);
  expect(sql).toContain(`, ${totalCents}, `);
  expect(sql).not.toContain(`'${totalCents}'`);
  if (discountPct === "∅") expect(sql).toContain(", NULL, ");
  expect(sql.endsWith(");")).toBe(true);
});

test("record view closes via Escape", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('#tbody tr').first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#record-dialog")).toBeHidden();
});
