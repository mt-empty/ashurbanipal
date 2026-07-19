import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

const SEEDED_TABLES = [
  "audit_log",
  "events",
  "orders",
  "payments",
  "products",
  "reviews",
  "saved_reports",
  "sessions",
  "support_tickets",
  "users",
];

test("sidebar lists all seeded tables alphabetically with approx row counts", async ({ page }) => {
  await gotoApp(page);
  const buttons = page.locator("#tables button");
  await expect(buttons).toHaveCount(SEEDED_TABLES.length);
  await expect(buttons).toHaveText(
    SEEDED_TABLES.map((name) => new RegExp(`^${name}~\\d+$`)),
  );
});

test("commented tables get a title tooltip, uncommented tables don't", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator('#tables button[data-table="users"]')).toHaveAttribute(
    "title",
    /.+/,
  );
  await expect(
    page.locator('#tables button[data-table="products"]'),
  ).not.toHaveAttribute("title");
});

test("sidebar search filters the table list live and is case-insensitive", async ({ page }) => {
  await gotoApp(page);
  await page.locator("#table-filter").fill("PAY");
  const visible = page.locator("#tables li:not([hidden])");
  await expect(visible).toHaveCount(1);
  await expect(visible.locator("button")).toContainText("payments");
  await expect(page.locator("#tables-empty")).toBeHidden();

  await page.locator("#table-filter").fill("");
  await expect(page.locator("#tables li:not([hidden])")).toHaveCount(SEEDED_TABLES.length);
});

test("sidebar search with no matches shows the empty-state message", async ({ page }) => {
  await gotoApp(page);
  await page.locator("#table-filter").fill("zzz-no-such-table");
  await expect(page.locator("#tables li:not([hidden])")).toHaveCount(0);
  await expect(page.locator("#tables-empty")).toBeVisible();
  await expect(page.locator("#tables-empty")).toHaveText("no matching tables");
});

test("selecting a table updates the current-table chrome", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await expect(page.locator("#current")).toHaveText("products");
  await expect(page).toHaveTitle("products — Ashurbanipal");
  await expect(page.locator('#tables button[data-table="products"]')).toHaveClass(/active/);
  await expect(page.locator('#tables button[data-table="products"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator('#tables button[data-table="users"]')).not.toHaveClass(/active/);
});
