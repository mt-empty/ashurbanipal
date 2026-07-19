import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

test("the sidebar loading spinner appears without shifting row layout (screenshot)", async ({
  page,
}) => {
  await gotoApp(page);
  await page.locator("#tables button.active").waitFor(); // initial load settled

  await page.route("**/api/tables/data*", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.locator('#tables button[data-table="orders"]').click();

  const row = page.locator("#tables li").filter({ has: page.locator('button[data-table="orders"]') });
  await expect(row.locator("button.loading")).toHaveCount(1);
  await expect(row).toHaveScreenshot("sidebar-loading-row.png");
});

test("a failed load leaves the previous table's rows and active state untouched", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstIdBefore = await page
    .locator('#tbody tr').first().locator('td[data-col="id"] .cell-text')
    .textContent();

  await page.route("**/api/tables/data*", (route) => route.abort("failed"));
  await page.locator('#tables button[data-table="users"]').click();
  await expect(page.locator("#error")).not.toBeEmpty();

  // Chrome/status must still describe the table that's actually rendered.
  await expect(page.locator("#current")).toHaveText("orders");
  await expect(page.locator('#tables button[data-table="orders"]')).toHaveClass(/active/);
  await expect(page.locator('#tables button[data-table="users"]')).not.toHaveClass(/active/);
  const firstIdAfter = await page
    .locator('#tbody tr').first().locator('td[data-col="id"] .cell-text')
    .textContent();
  expect(firstIdAfter).toBe(firstIdBefore);
});

test("errors are surfaced as a visible role=alert region, not just logged", async ({ page }) => {
  // This table never finishes loading (invalid sort column -> 400 before
  // updateActiveTableChrome() ever runs), so wait on #error, not #current.
  await gotoApp(page, "?table=orders&sort=nonexistent_col");
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#error")).toBeVisible();
});
