import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

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

test("a slow, superseded response never overwrites a newer table's render", async ({ page }) => {
  // Regression test for docs/known-issues.md #2 (fixed): forces the exact
  // out-of-order race — an older request for "orders" is delayed so it
  // resolves *after* a newer request for "users" has already rendered.
  // loadData()'s token guard should discard the late "orders" response
  // outright rather than letting it overwrite "users"'s already-current
  // grid/chrome.
  await gotoApp(page);
  await page.route("**/api/tables/data*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("table") === "orders") {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await route.continue();
  });

  await page.locator('#tables button[data-table="orders"]').click(); // slow, started first
  await page.locator('#tables button[data-table="users"]').click(); // fast, resolves first
  await page.locator("#current").getByText("users", { exact: true }).waitFor();

  // Give the delayed "orders" response time to land too.
  await page.waitForTimeout(1300);

  await expect(page.locator("#current")).toHaveText("users");
  await expect(page.locator('#tables button[data-table="users"]')).toHaveClass(/active/);
  await expect(page.locator('#tbody td[data-col="email"]').first()).toBeVisible();
  await expect(page.locator('#tbody td[data-col="status"]')).toHaveCount(0); // orders' column
});

test("errors are surfaced as a visible role=alert region, not just logged", async ({ page }) => {
  // This table never finishes loading (invalid sort column -> 400 before
  // updateActiveTableChrome() ever runs), so wait on #error, not #current.
  await gotoApp(page, "?table=orders&sort=nonexistent_col");
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#error")).toBeVisible();
});
