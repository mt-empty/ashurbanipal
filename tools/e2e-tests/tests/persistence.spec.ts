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

test("the applied filter persists to the URL, never localStorage", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");

  const state = await uiState(page);
  expect(state).not.toHaveProperty("filter");
  expect(new URL(page.url()).searchParams.get("filter")).toBe("status = completed");

  await gotoApp(page); // bare URL — no filter param, restore-from-localStorage only
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue(""); // localStorage never carried it
});

const statusCells = (page: import("@playwright/test").Page) =>
  page.locator('#tbody td[data-col="status"] .cell-text');

test("a malformed filter URL param resets to no filter silently", async ({ page }) => {
  await gotoApp(page, "?table=orders&filter=" + encodeURIComponent("status = 'unterminated"));
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#filter")).toHaveValue("");
  await expect
    .poll(async () => new Set(await statusCells(page).allTextContents()).size)
    .toBeGreaterThan(1); // unfiltered — mixed statuses still visible
});

test("a filter URL param naming a column the table lacks resets silently", async ({ page }) => {
  // Parses fine, so tryParseFilterDsl accepts it — the backend is what
  // rejects it (a link shared to a deployment where the column has drifted
  // away). Must degrade like a stale sort does, not dead-end the link (R5).
  await gotoApp(page, "?table=orders&filter=" + encodeURIComponent("nosuchcol = 1"));
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#filter")).toHaveValue("");
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("a filter survives no better than the table it was written against", async ({ page }) => {
  // ?table= names a table that isn't here, so loadTables falls back to the
  // first one — and the filter, written against the named table's columns,
  // must not ride along onto a table that may not have them.
  await gotoApp(page, "?table=nosuchtable&filter=" + encodeURIComponent("status = completed"));
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#filter")).toHaveValue("");
  await expect(page.locator("#current")).not.toHaveText("—");
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("a filter URL param restores the filtered view on load", async ({ page }) => {
  await gotoApp(page, "?table=orders&filter=" + encodeURIComponent("status = completed"));
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue("status = completed");
  await expect
    .poll(async () => {
      const values = await statusCells(page).allTextContents();
      return values.length > 0 && values.every((v) => v === "completed");
    })
    .toBe(true);
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
