import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, applyFilter, waitForIdle } from "./support/helpers";

// The refresh segment inserts a handful of rows straight into the
// devcontainer Postgres so the app can discover them on re-fetch. Marked
// with a sentinel event_type and cleared on both entry and exit, so a run
// killed mid-recording self-heals on the next run rather than leaking rows
// into the DB the conformance suites assert against. Dev-only, manual —
// `mise run conformance:seed-gen` resets the DB if it ever drifts.
const SHOWCASE_EVENT_TYPE = "__showcase_refresh__";
const psql = (sql: string) => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set to record the showcase");
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
};

// Not part of the correctness suite — a scripted walkthrough recorded to
// video for a showcase clip (see playwright.showcase.config.ts). The
// timeouts below hold a frame long enough for a human viewer to read it;
// that's a different job than the waitForIdle/poll-based waits the rest of
// the suite uses to avoid flakiness, so it's exempt from the
// no-waitForTimeout rule those tests follow.
const beat = (page: import("@playwright/test").Page) => page.waitForTimeout(700);

test("showcase: browse tables, filter down to one row, inspect jsonb, catch live rows on refresh, open API reference", async ({
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

  // Refresh: rows added since the last look wash in green for 3s. events
  // has a bigint identity PK, so sorting it id-descending parks anything
  // just inserted at the top of page 1 where the tint is visible.
  psql(`DELETE FROM events WHERE event_type = '${SHOWCASE_EVENT_TYPE}'`);
  await selectTable(page, "events");
  const idHeader = page.locator('#thead th[data-col="id"]');
  await idHeader.click(); // first click sorts ascending...
  await waitForIdle(page);
  await idHeader.click(); // ...second flips it to descending — newest first
  await waitForIdle(page);
  try {
    psql(
      `INSERT INTO events (event_type) SELECT '${SHOWCASE_EVENT_TYPE}' FROM generate_series(1, 5)`,
    );
    await page.locator("#refresh").click();
    await waitForIdle(page);
    await expect(page.locator("#tbody tr.row-new")).toHaveCount(5);
    await expect(page.locator("#status")).toHaveText("5 new");
    await beat(page); // hold on the green wash (it keeps fading into the next shot)
  } finally {
    psql(`DELETE FROM events WHERE event_type = '${SHOWCASE_EVENT_TYPE}'`);
  }

  // API reference for AI agents.
  await page.locator("#api-help-btn").click();
  await expect(page.locator("#api-help-dialog")).toBeVisible();
  await beat(page);
  await beat(page);
});
