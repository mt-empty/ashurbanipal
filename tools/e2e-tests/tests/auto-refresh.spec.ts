import { test, expect, type Page } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

// The mocked /tables/data response is mutable and counted, and time is the
// page clock's: a tick fires on fastForward, never on a real wait.

type Row = [number, string];

function payload(rows: Row[]) {
  return {
    columns: [
      { name: "id", type: "integer", key: "pk" },
      { name: "label", type: "text" },
    ],
    rows: rows.map(([id, label]) => ({ id: String(id), label })),
    total_approx: rows.length,
  };
}

async function setup(page: Page, rows: Row[] = [[1, "a"], [2, "b"]]) {
  const mock = { body: payload(rows), status: 200, hits: 0, gate: null as Promise<void> | null };
  await page.clock.install();
  await gotoApp(page);
  await page.route("**/api/tables/data*", async (route) => {
    mock.hits++;
    if (mock.gate) await mock.gate;
    if (mock.status !== 200) {
      await route.fulfill({ status: mock.status, json: { title: "Service Unavailable", code: "unavailable" } });
    } else {
      await route.fulfill({ json: mock.body });
    }
  });
  await selectTable(page, "users");
  return mock;
}

async function choose(page: Page, label: string) {
  await page.locator("#refresh-menu-btn").click();
  await page.getByRole("radio", { name: label, exact: true }).check();
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** Advances one interval and waits for the tick's request to land. */
async function tick(page: Page, mock: { hits: number }, ms = 5000) {
  const before = mock.hits;
  await page.clock.fastForward(ms);
  await expect.poll(() => mock.hits).toBe(before + 1);
  await waitForIdle(page);
}

test("auto-refresh is off by default and makes no requests", async ({ page }) => {
  const mock = await setup(page);
  const before = mock.hits;
  await page.clock.fastForward(120_000);
  expect(mock.hits).toBe(before);
  await expect(page.locator("#refresh-interval")).toBeHidden();
  await expect(page.locator("#load-bar")).not.toHaveAttribute("data-state", /.*/);
});

test("choosing 5 s labels the button and refreshes once per interval", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  await expect(page.locator("#refresh-interval")).toHaveText("· 5 s");
  await expect(page.locator("#refresh")).toHaveAttribute("aria-label", "refresh, automatically every 5 s");
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "countdown");

  await tick(page, mock);
  await tick(page, mock);
  await choose(page, "Off");
  const after = mock.hits;
  await page.clock.fastForward(30_000);
  expect(mock.hits).toBe(after);
  await expect(page.locator("#refresh-interval")).toBeHidden();
});

test("a tick is skipped while a user-started fetch is still running", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  let release!: () => void;
  mock.gate = new Promise<void>((r) => (release = r));
  const before = mock.hits;
  await page.locator("#refresh").click();
  await expect.poll(() => mock.hits).toBe(before + 1);

  await page.clock.fastForward(5000);
  expect(mock.hits).toBe(before + 1);

  mock.gate = null;
  release();
  await waitForIdle(page);
  await tick(page, mock);
});

test("any fetch restarts the countdown", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  await page.clock.fastForward(4000);
  const before = mock.hits;
  await page.locator("#refresh").click();
  await expect.poll(() => mock.hits).toBe(before + 1);
  await waitForIdle(page);

  await page.clock.fastForward(4000);
  expect(mock.hits).toBe(before + 1);
  await tick(page, mock, 1000);
});

test("a hidden tab pauses ticks and refreshes on return when overdue", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  await setHidden(page, true);
  const before = mock.hits;
  await page.clock.fastForward(20_000);
  expect(mock.hits).toBe(before);

  await setHidden(page, false);
  await expect.poll(() => mock.hits).toBe(before + 1);
});

test("five failed refreshes turn it off and report the last error", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  mock.status = 503;
  for (let i = 0; i < 4; i++) await tick(page, mock);
  await expect(page.locator("#refresh-interval")).toHaveText("· 5 s");

  await tick(page, mock);
  await expect(page.locator("#error")).toHaveText(
    "Auto-refresh turned off after 5 failed refreshes. Last error: Service Unavailable.",
  );
  await expect(page.locator("#refresh-interval")).toBeHidden();
  const after = mock.hits;
  await page.clock.fastForward(30_000);
  expect(mock.hits).toBe(after);
});

test("30 minutes without input turns it off and says so", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  const before = mock.hits;
  await page.clock.fastForward(31 * 60_000);

  await expect(page.locator("#view-notice")).toBeVisible();
  await expect(page.locator("#view-notice-text")).toHaveText("Auto-refresh turned off after 30 minutes without activity.");
  await expect(page.locator("#refresh-interval")).toBeHidden();
  expect(mock.hits).toBe(before);
});

test("a tick tints new rows, shows the +N chip and the updated time", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  mock.body = payload([[1, "a"], [2, "b"], [3, "c"], [4, "d"]]);
  await tick(page, mock);

  await expect(page.locator("#tbody tr.row-new")).toHaveCount(2);
  await expect(page.locator("#row-new-chip")).toHaveText("+2 new");
  await expect(page.locator("#row-updated")).toContainText(/updated \d{2}:\d{2}:\d{2}/);
  await expect(page.locator("#status")).toHaveText("2 new");

  await tick(page, mock);
  await expect(page.locator("#status")).toHaveText("");
});
