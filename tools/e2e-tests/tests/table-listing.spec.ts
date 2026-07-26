import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

const SEEDED_TABLES = [
  "_conformance_meta",
  "audit_log",
  "events",
  "feature_flags",
  "inventory_counts",
  "inventory_locations",
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
  // approx_rows is -1 for a never-ANALYZEd table (spec/protocol.md
  // §5.4.4's staleness allowance) — _conformance_meta and feature_flags
  // are seeded that way deliberately, so the count isn't always \d+.
  await expect(buttons).toHaveText(
    SEEDED_TABLES.map((name) => new RegExp(`^${name}~(-1|\\d+)$`)),
  );
});

test("title tooltip includes the comment when present, and is just the name otherwise", async ({
  page,
}) => {
  await gotoApp(page);
  // Every button gets a title (name is the R8 truncation escape hatch for
  // a long table name, see .row-name's CSS) — commented tables get the
  // comment appended, uncommented ones just the bare name.
  await expect(page.locator('#tables button[data-table="users"]')).toHaveAttribute(
    "title",
    /^users — .+/,
  );
  await expect(page.locator('#tables button[data-table="products"]')).toHaveAttribute(
    "title",
    "products",
  );
});

test("a long table name truncates instead of pushing the row count out", async ({ page }) => {
  await gotoApp(page);
  const nameSpan = page.locator('#tables button[data-table="support_tickets"] .row-name');
  const overflow = await nameSpan.evaluate((el) => getComputedStyle(el).overflow);
  const textOverflow = await nameSpan.evaluate((el) => getComputedStyle(el).textOverflow);
  const minWidth = await nameSpan.evaluate((el) => getComputedStyle(el).minWidth);
  expect(overflow).toBe("hidden");
  expect(textOverflow).toBe("ellipsis");
  expect(minWidth).toBe("0px"); // must override the flex-item min-width:auto default to shrink at all
  // The count must stay fully visible regardless of name length — this is
  // the actual symptom being fixed (a long name pushing/clipping it).
  await expect(
    page.locator('#tables button[data-table="support_tickets"] .count'),
  ).toBeVisible();
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
