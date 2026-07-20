import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

test("an empty table renders the empty-state row and a real 0 count, not -1", async ({ page }) => {
  await gotoApp(page);
  await expect(
    page.locator('#tables button[data-table="saved_reports"] .count'),
  ).toHaveText("~0");

  await selectTable(page, "saved_reports");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#page")).toHaveText("page 1 · ~0 rows");
  const emptyRow = page.locator("#tbody tr.empty td");
  await expect(emptyRow).toHaveText("No rows match this view.");
  await expect(page.locator("#next")).toBeDisabled();
});

test("common-values on an empty table returns empty, not an error", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "saved_reports");
  await page.locator('.common-values-btn[aria-label="common values for is_public"]').click();
  await expect(page.locator("#cv-pop")).toBeVisible();
  await expect(page.locator("#cv-pop-list .cv-empty")).toHaveText("no common values available");
  await expect(page.locator("#error")).toBeEmpty();
});
