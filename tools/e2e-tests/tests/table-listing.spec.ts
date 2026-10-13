import { test, expect } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

const SEEDED_TABLES = [
  "_conformance_meta",
  "audit_log",
  "events",
  "feature_flags",
  "inventory_counts",
  "inventory_locations",
  "order_extra",
  "orders",
  "payments",
  "products",
  "reviews",
  "saved_reports",
  "sessions",
  "support_tickets",
  "users",
];

test("table chips list all seeded tables alphabetically with approx row counts", async ({ page }) => {
  await gotoApp(page);
  const buttons = page.locator("#tables button");
  await expect(buttons).toHaveCount(SEEDED_TABLES.length);
  // _conformance_meta/feature_flags are deliberately never ANALYZEd, so
  // the frontend shows "?" (formatApproxCount) instead of a raw -1.
  await expect(buttons).toHaveText(
    SEEDED_TABLES.map((name) => new RegExp(`^${name}(~\\d+|\\?)$`)),
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

test("a long table list collapses to two lines behind '+ N more' and expands in place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await gotoApp(page);
  const more = page.locator("#tables-more");
  await expect(more).toHaveText(/^\+ \d+ more$/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const capped = await page.locator("#tables").evaluate((el) => el.getBoundingClientRect().height);
  await more.click();
  await expect(more).toHaveText("show fewer");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const expanded = await page.locator("#tables").evaluate((el) => el.getBoundingClientRect().height);
  expect(expanded).toBeGreaterThan(capped);
});

test("the active table is never hidden behind the cap", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  // users is the last chip, so it lands past line two at this width.
  await gotoApp(page, "?table=users");
  await expect(page.locator("#tables-more")).toHaveText("show fewer");
  await expect(page.locator('#tables button[data-table="users"]')).toHaveClass(/active/);
});

test("a wide window shows every table with no cap control", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await gotoApp(page);
  await expect(page.locator("#tables-more")).toBeHidden();
});

test("a column name is capped with an ellipsis and keeps its full name in a title", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const name = page.locator('th[data-col="total_cents"] .col-name');
  const style = await name.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { overflow: cs.overflow, textOverflow: cs.textOverflow, maxWidth: cs.maxWidth };
  });
  expect(style).toEqual({ overflow: "hidden", textOverflow: "ellipsis", maxWidth: "256px" });
  await expect(name).toHaveAttribute("title", /^total_cents/);
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
