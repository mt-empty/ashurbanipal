import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable, waitForIdle, waitForTable } from "./support/helpers";

test("next/prev paginate and toggle button disabled state", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await expect(page.locator("#prev")).toBeDisabled();
  await expect(page.locator("#page")).toHaveText("page 1");

  const firstIdPage1 = await page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text').textContent();

  await page.locator("#next").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 2");
  await expect(page.locator("#prev")).toBeEnabled();
  const firstIdPage2 = await page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text').textContent();
  expect(firstIdPage2).not.toBe(firstIdPage1);

  await page.locator("#prev").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 1");
  await expect(page.locator("#prev")).toBeDisabled();
  const firstIdBack = await page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text').textContent();
  expect(firstIdBack).toBe(firstIdPage1);
});

test("limit is clamped server-side to 100 even if the URL requests more", async ({ page }) => {
  await gotoApp(page, "?table=orders&limit=999");
  await waitForTable(page, "orders");
  await expect(page.locator("#tbody tr")).toHaveCount(100);
});

test("paging works at scale against a 13.6k-row table (reviews)", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "reviews");
  await expect(page.locator("#page")).toHaveText("page 1");
  await expect(page.locator("#row-meta")).toHaveText(/^ · ~1\d{4} rows · \d+ columns$/);
  const firstIdPage1 = await page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text').textContent();

  await page.locator("#next").click();
  await waitForIdle(page);
  await expect(page.locator("#page")).toHaveText("page 2");
  const firstIdPage2 = await page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text').textContent();
  expect(firstIdPage2).not.toBe(firstIdPage1);
  await expect(page.locator("#tbody tr")).toHaveCount(50);
});

test("the last partial page of a 30k-row table (audit_log) disables next", async ({ page }) => {
  // 30,000 rows, limit 50 (default) -> offset 29,975 leaves exactly 25.
  await gotoApp(page, "?table=audit_log&offset=29975");
  await waitForTable(page, "audit_log");
  await expect(page.locator("#tbody tr")).toHaveCount(25);
  await expect(page.locator("#next")).toBeDisabled();
  await expect(page.locator("#prev")).toBeEnabled();
});
