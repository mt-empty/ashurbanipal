import { test, expect } from "@playwright/test";
import { gotoApp } from "./support/helpers";

test("API reference dialog opens with non-empty JSON and closes", async ({ page }) => {
  await gotoApp(page);
  await page.locator("#api-help-btn").click();
  await expect(page.locator("#api-help-dialog")).toBeVisible();

  const text = await page.locator("#api-help-pre").textContent();
  const parsed = JSON.parse(text!);
  expect(Object.keys(parsed).length).toBeGreaterThan(0);

  await page.locator('#api-help-dialog button[aria-label="close"]').click();
  await expect(page.locator("#api-help-dialog")).toBeHidden();
});
