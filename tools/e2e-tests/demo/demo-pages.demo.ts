import { expect, type Page, test } from "../tests/support/fixtures";
import { applyFilter, selectTable, waitForIdle } from "../tests/support/helpers";
import { ORDERS_USERS, writeSql } from "../tests/support/join";

// The two GitHub Pages demos, served from docs/ as Pages serves them
// (frontend/demo-preview.mjs): synthetic at /demo/, PGlite at /demo/live/.

// The live page starts Postgres in a worker before its first table list.
async function openDemo(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("#tables")).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
  await waitForIdle(page);
}

async function switchSource(page: Page, source: string, table: string) {
  await page.locator("#source-select").selectOption(source);
  await expect(page.locator(`#tables [data-table="${table}"]`)).toBeVisible({ timeout: 60_000 });
  await waitForIdle(page);
}

for (const [mode, path] of [
  ["synthetic", "/demo/"],
  ["live", "/demo/live/"],
] as const) {
  test(`${mode}: browses, filters and inspects both sources`, async ({ page }) => {
    await openDemo(page, path);
    await expect(page.locator("#source-select")).toHaveValue("shop");

    await selectTable(page, "orders");
    await applyFilter(page, "status = shipped");
    const statuses = await page.locator('#tbody td[data-col="status"] .cell-text').allTextContents();
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(["shipped"]));

    await page.locator("#structure-btn").click();
    await expect(page.locator("#structure-title")).toHaveText("structure — public.orders");
    await expect(page.locator("#structure-body")).toContainText("orders_user_id_fkey");
    await page.keyboard.press("Escape");
    await expect(page.locator("#structure-dialog")).toBeHidden();

    await switchSource(page, "tracker", "location_pings");
    await selectTable(page, "idle_alerts");
    await expect(page.locator("#tbody tr").first()).toBeVisible();
  });
}

// The shims answer fetch inside the page, so there is no network response to
// wait on: these wait on what the page shows.
async function openJoin(page: Page, path: string) {
  await openDemo(page, path);
  await selectTable(page, "orders");
  await page.locator("#join-btn").click();
  await writeSql(page, ORDERS_USERS);
}

test("synthetic: a join points to the live demo", async ({ page }) => {
  await openJoin(page, "/demo/");
  await page.locator("#join-run").click();
  await expect(page.locator("#join-error")).toContainText("live demo");
});

test("live: a join runs on Postgres", async ({ page }) => {
  await openJoin(page, "/demo/live/");
  await page.locator("#join-run").click();
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"]);
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("live: a query past the time limit is stopped, and Retry starts Postgres again", async ({ page }) => {
  await openJoin(page, "/demo/live/");
  await page.evaluate(() => {
    window.__DEMO_QUERY_TIMEOUT_MS = 1;
  });
  await page.locator("#join-run").click();
  await expect(page.locator("#join-notice")).toContainText("took longer than the time limit");

  await page.evaluate(() => {
    window.__DEMO_QUERY_TIMEOUT_MS = undefined;
  });
  await page.locator("#join-notice").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"], { timeout: 60_000 });
  await expect(page.locator("#join-notice")).toBeHidden();
});

declare global {
  interface Window {
    __DEMO_QUERY_TIMEOUT_MS?: number;
  }
}
