import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, applyFilter, uiState } from "./support/helpers";

test("table/sort/order/limit round-trip through localStorage across a fresh visit", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click();
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");

  // Bare URL, no query params — forces restore-from-localStorage, not URL.
  await gotoApp(page);
  await page.locator("#current").getByText("products", { exact: true }).waitFor();
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
});

test("a URL query param wins over a conflicting localStorage value", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click(); // localStorage: products, price asc

  await gotoApp(page, "?table=users&sort=email&order=desc");
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await expect(page.locator('th[data-col="email"]')).toHaveAttribute("aria-sort", "descending");
});

test("corrupted localStorage is discarded and falls back to the default view", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem("ashurbanipal_ui", "not valid json{"));

  await gotoApp(page); // reload with the corrupted value already in place
  // Falls back silently rather than wedging — some table still loads.
  await expect(page.locator("#current")).not.toHaveText("—");
  await expect(page.locator("#error")).toBeEmpty();
  const stored = await page.evaluate(() => localStorage.getItem("ashurbanipal_ui"));
  expect(stored).not.toBe("not valid json{");
});

test("the applied filter is never persisted to localStorage or the URL", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");

  const state = await uiState(page);
  expect(state).not.toHaveProperty("filter");
  expect(new URL(page.url()).searchParams.has("filter")).toBe(false);

  await gotoApp(page); // bare URL, restore from localStorage
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue("");
});

test("hidden columns persist across a fresh visit, scoped per table", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#columns-btn").click();
  await page.locator("#columns-pop-list label", { hasText: "price" }).locator("input").uncheck();
  await expect(page.locator('th[data-col="price"]')).toHaveClass(/col-hidden/);

  await gotoApp(page);
  await page.locator("#current").getByText("products", { exact: true }).waitFor();
  await expect(page.locator('th[data-col="price"]')).toHaveClass(/col-hidden/);
});
