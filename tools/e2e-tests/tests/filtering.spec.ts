import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, applyFilter, clearFilterViaSearchEvent } from "./support/helpers";

// total_approx (the pager's "~N rows") is deliberately the whole table's
// pg_class.reltuples estimate regardless of any applied filter — same
// "cheap over exact" philosophy as /table-counts (see docs/design.md §4) —
// so these assert on actual row content, not that summary count.
const statusCells = (page: import("@playwright/test").Page) =>
  page.locator('#tbody td[data-col="status"] .cell-text');

// Under full test parallelism, several workers hit the one shared demo
// server/browser-CPU budget at once, which can widen the gap between "the
// click/dispatch returned" and "the resulting re-render actually landed."
// waitForIdle (aria-busy) narrows that gap but a single post-wait snapshot
// can still occasionally race it — so these poll the real DOM content
// directly (Playwright's recommended pattern) instead of reading once.
test("applying a filter narrows the visible rows to matching values only", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const unfiltered = await statusCells(page).allTextContents();
  expect(new Set(unfiltered).size).toBeGreaterThan(1); // sanity: mixed statuses exist

  await applyFilter(page, "status = completed");
  await expect(page.locator("#error")).toBeEmpty();
  await expect
    .poll(async () => {
      const values = await statusCells(page).allTextContents();
      return values.length > 0 && values.every((v) => v === "completed");
    })
    .toBe(true);
});

test("clearing the filter via the search event resets to unfiltered", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  await expect
    .poll(async () => new Set(await statusCells(page).allTextContents()).size)
    .toBe(1);

  await clearFilterViaSearchEvent(page);
  await expect
    .poll(async () => new Set(await statusCells(page).allTextContents()).size)
    .toBeGreaterThan(1);
});

test("an invalid filter surfaces the backend's rejection text verbatim", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "nonexistent_column = 1");
  await expect(page.locator("#error")).toHaveText(/not allowed.*nonexistent_column/i);
});

test("IS NULL filters to only null-valued rows", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "age IS NULL");
  await expect(page.locator("#error")).toBeEmpty();
  const ageCells = page.locator('#tbody td[data-col="age"] .cell-text');
  await expect
    .poll(async () => {
      const values = await ageCells.allTextContents();
      return values.length > 0 && values.every((v) => v === "∅");
    })
    .toBe(true);
});

test("IS NOT NULL excludes null-valued rows", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "age IS NOT NULL");
  await expect(page.locator("#error")).toBeEmpty();
  const ageCells = page.locator('#tbody td[data-col="age"] .cell-text');
  await expect
    .poll(async () => {
      const values = await ageCells.allTextContents();
      return values.length > 0 && !values.includes("∅");
    })
    .toBe(true);
});

test("column autocomplete suggests all columns at an empty/condition-start boundary", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await page.locator("#filter").click();
  await expect(page.locator("#filter-suggest")).toBeVisible();
  const suggestions = await page.locator("#filter-suggest-list button").allTextContents();
  expect(suggestions).toEqual([
    "id",
    "email",
    "full_name",
    "age",
    "is_active",
    "login_count",
    "metadata",
    "last_login_at",
    "created_at",
  ]);
});

test("column autocomplete is not offered mid-condition (past a column into operator position)", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const filter = page.locator("#filter");
  await filter.fill("age ");
  await expect(page.locator("#filter-suggest")).toBeHidden();
});
