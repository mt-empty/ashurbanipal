import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, applyFilter, waitForIdle } from "./support/helpers";

// Not part of the correctness suite — a scripted walkthrough recorded to
// video for a showcase clip (see playwright.showcase.config.ts). The
// timeouts below hold a frame long enough for a human viewer to read it;
// that's a different job than the waitForIdle/poll-based waits the rest of
// the suite uses to avoid flakiness, so it's exempt from the
// no-waitForTimeout rule those tests follow.
const beat = (page: import("@playwright/test").Page) => page.waitForTimeout(700);

test("showcase: browse tables, filter down to one row, inspect jsonb, open API reference", async ({
  page,
}) => {
  // Pins dark theme before the app's own head-inline script reads
  // localStorage on first paint (see dbviewer.html's THEME_KEY handling) —
  // addInitScript runs ahead of any page script on every navigation.
  await page.addInitScript(() => localStorage.setItem("ashurbanipal_theme", "dark"));

  await gotoApp(page);
  await beat(page);

  await selectTable(page, "users");
  await beat(page);

  await selectTable(page, "products");
  await beat(page);

  await selectTable(page, "orders");
  await beat(page);

  // Click a "pending" status cell's filter button — narrows to ~two dozen rows.
  const pendingCell = page
    .locator('#tbody td[data-col="status"] .cell-text', { hasText: "pending" })
    .first()
    .locator("xpath=ancestor::td[1]");
  await pendingCell.hover();
  await pendingCell.locator(".filter-eq").click();
  await waitForIdle(page);
  await beat(page);

  // Narrow further, by hand, to a single row.
  await applyFilter(page, "status = pending AND total_cents = 936");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr")).toHaveCount(1);
  await beat(page);

  // Open the jsonb cell popover and toggle a nested node to show the
  // colored, collapsible tree.
  const jsonCell = page.locator('#tbody tr').first().locator('td[data-col="line_items"] .cell-text');
  await jsonCell.click();
  await expect(page.locator("#cell-pop")).toBeVisible();
  await beat(page);
  await page.locator("#cell-json .json-fold").first().click();
  await beat(page);
  await page.locator("#cell-json .json-fold").first().click();
  await beat(page);

  await page.locator("#current").click();
  await expect(page.locator("#cell-pop")).toBeHidden();

  // API reference for AI agents.
  await page.locator("#api-help-btn").click();
  await expect(page.locator("#api-help-dialog")).toBeVisible();
  await beat(page);
  await beat(page);
});
