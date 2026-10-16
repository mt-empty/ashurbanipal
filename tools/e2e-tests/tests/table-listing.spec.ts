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

// A dev database may also hold zz_demo_* tables (many empty tables for looking
// at the chip cap by hand); the specs below ignore them.
test("table chips list all seeded tables alphabetically with approx row counts", async ({ page }) => {
  await gotoApp(page);
  const buttons = page.locator('#tables button[data-table]:not([data-table^="zz_demo_"])');
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

// Narrow enough that the seeded tables wrap past three lines.
const NARROW = { width: 360, height: 800 };
const visibleChips = (page: import("@playwright/test").Page) =>
  page.locator("#tables li:not([hidden]):not(#tables-more-item)");

// The button must end the collapsed list: within three rows, at the list's right edge.
async function expectButtonOnLastRowAtRight(page: import("@playwright/test").Page) {
  const geometry = await page.evaluate(() => {
    const ul = document.getElementById("tables") as HTMLElement;
    const item = document.getElementById("tables-more-item") as HTMLElement;
    const tops = new Set(
      [...ul.querySelectorAll<HTMLElement>("li:not([hidden])")].map((li) => li.offsetTop),
    );
    return {
      rows: tops.size,
      buttonRow: item.offsetTop,
      lastRow: Math.max(...tops),
      gapToRightEdge: ul.getBoundingClientRect().right - item.getBoundingClientRect().right,
    };
  });
  expect(geometry.rows).toBeLessThanOrEqual(3);
  expect(geometry.buttonRow).toBe(geometry.lastRow);
  expect(geometry.gapToRightEdge).toBeLessThan(2);
}

test("a long table list collapses to three lines behind '+ N more' and expands in place", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await gotoApp(page);
  const more = page.locator("#tables-more");
  await expect(more).toHaveText(/^\+ \d+ more$/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const lines = await visibleChips(page).evaluateAll((els) => new Set(els.map((e) => (e as HTMLElement).offsetTop)).size);
  expect(lines).toBeLessThanOrEqual(3);
  await expectButtonOnLastRowAtRight(page);
  const collapsed = await visibleChips(page).count();
  // Keyed by table; the active chip is left out, since a collapsed list may pull it up.
  const place = (names?: string[]) =>
    page.evaluate((only) => {
      const out: Record<string, number[]> = {};
      for (const li of document.querySelectorAll<HTMLElement>("#tables li:not([hidden])")) {
        const btn = li.querySelector<HTMLElement>("button[data-table]");
        const name = btn?.dataset.table;
        if (!name || btn?.classList.contains("active") || (only && !only.includes(name))) continue;
        out[name] = [li.offsetTop, li.offsetLeft];
      }
      return out;
    }, names);
  const before = await place();
  await more.click();
  await expect(more).toHaveText("show fewer");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await visibleChips(page).count()).toBeGreaterThan(collapsed);
  // The button is the last item, so expanding never moves the chips above it.
  expect(await place(Object.keys(before))).toEqual(before);
  await expect(page.locator("#tables li[hidden]:not(#tables-more-item)")).toHaveCount(0);
});

test("the active table stays visible in a collapsed list, and 'show fewer' keeps it collapsed", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  // users is past line three at this width, so it starts out in the hidden part.
  await gotoApp(page, "?table=users");
  const users = page.locator('#tables button[data-table="users"]');
  const more = page.locator("#tables-more");
  await expect(users).toHaveClass(/active/);
  await expect(users).toBeVisible();
  await expect(more).toHaveText(/^\+ \d+ more$/);
  await expectButtonOnLastRowAtRight(page);
  await more.click();
  await expect(more).toHaveText("show fewer");
  await more.click();
  await expect(more).toHaveText(/^\+ \d+ more$/);
  await expect(users).toBeVisible();
  // Hidden chips leave the tab order and the accessibility tree.
  await expect(page.locator("#tables li[hidden]:not(#tables-more-item)").first()).toBeAttached();
});

test("a chip pulled up from the hidden part gets a divider only on a line with other chips", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await gotoApp(page, "?table=users");
  await expect(page.locator('#tables button[data-table="users"]')).toBeVisible();
  const pulled = page.locator("#tables li.pulled");
  expect(await pulled.count()).toBeLessThanOrEqual(1);
  if ((await pulled.count()) === 1) {
    const sharesLine = await pulled.evaluate((el) => {
      let prev = el.previousElementSibling as HTMLElement | null;
      while (prev?.hidden) prev = prev.previousElementSibling as HTMLElement | null;
      return prev?.offsetTop === (el as HTMLElement).offsetTop;
    });
    expect(sharesLine).toBe(true);
  }
  await page.locator('#tables button[data-table="audit_log"]').click();
  await expect(page.locator("#tables li.pulled")).toHaveCount(0);
});

test("a wide window shows every seeded table without expanding the list", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await gotoApp(page);
  for (const name of SEEDED_TABLES) await expect(page.locator(`#tables button[data-table="${name}"]`)).toBeVisible();
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
