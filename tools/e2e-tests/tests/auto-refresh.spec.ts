import { test, expect, type Page } from "./support/fixtures";
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

type Failure = { status: number; title: string; code: string };
const UNAVAILABLE: Failure = { status: 503, title: "Service Unavailable", code: "unavailable" };

async function setup(page: Page, rows: Row[] = [[1, "a"], [2, "b"]]) {
  const mock = { body: payload(rows), fail: null as Failure | null, hits: 0, gate: null as Promise<void> | null };
  await page.clock.install();
  await gotoApp(page);
  await page.route("**/api/tables/data*", async (route) => {
    mock.hits++;
    if (mock.gate) await mock.gate;
    const { fail } = mock;
    if (fail) await route.fulfill({ status: fail.status, json: { title: fail.title, code: fail.code } });
    else await route.fulfill({ json: mock.body });
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
  mock.fail = UNAVAILABLE;
  await tick(page, mock);
  await expect(page.locator("#error")).toHaveText("Service Unavailable");
  mock.fail = null;
  await tick(page, mock);
  await expect(page.locator("#error")).toBeEmpty();

  mock.fail = UNAVAILABLE;
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

test("arrow keys move the interval choice without closing the menu; Enter closes it", async ({ page }) => {
  await setup(page);
  await page.locator("#refresh-menu-btn").click();
  await page.getByRole("radio", { name: "Off", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#refresh-pop")).toBeVisible();
  await expect(page.getByRole("radio", { name: "10 s", exact: true })).toBeChecked();

  await page.keyboard.press("Enter");
  await expect(page.locator("#refresh-pop")).toBeHidden();
  await expect(page.locator("#refresh-menu-btn")).toBeFocused();
  await expect(page.locator("#refresh-interval")).toHaveText("· 10 s");
});

test("a tick leaves an error from the user's own action in place", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  mock.fail = UNAVAILABLE;
  await page.locator("#refresh").click();
  await expect(page.locator("#error")).toHaveText("Service Unavailable");

  mock.fail = null;
  await tick(page, mock);
  await expect(page.locator("#error")).toHaveText("Service Unavailable");
});

test("a slow tick shows the bar but does not announce loading", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  let release!: () => void;
  mock.gate = new Promise<void>((r) => (release = r));
  const before = mock.hits;
  await page.clock.fastForward(5000);
  await expect.poll(() => mock.hits).toBe(before + 1);
  await page.clock.fastForward(300);

  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");
  await expect(page.locator("#status")).not.toHaveText("loading…");
  mock.gate = null;
  release();
  await waitForIdle(page);
});

test("a tick the role can't read gets the plain-language message", async ({ page }) => {
  const mock = await setup(page);
  await choose(page, "5 s");
  mock.fail = { status: 403, title: "permission denied for table users", code: "not_readable" };
  await tick(page, mock);
  await expect(page.locator("#error")).toHaveText("you don't have access to users");
});

test("the countdown bar stays under the open filter suggestion list", async ({ page }) => {
  await setup(page);
  await choose(page, "5 s");
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "countdown");
  await page.locator("#filter").click();
  await expect(page.locator("#filter-suggest")).toBeVisible();
  const topAtBar = () =>
    page.evaluate(() => {
      const bar = (document.getElementById("load-bar") as HTMLElement).getBoundingClientRect();
      const list = (document.getElementById("filter-suggest") as HTMLElement).getBoundingClientRect();
      if (bar.top < list.top || bar.bottom > list.bottom) return "no overlap";
      const hit = document.elementFromPoint(list.left + list.width / 2, bar.top + 1);
      // Names whatever is on top, so a failure says what covered the list.
      if (hit?.closest("#filter-suggest")) return "filter-suggest";
      return hit?.closest("[id]")?.id ?? hit?.tagName ?? null;
    });
  await expect.poll(topAtBar).toBe("filter-suggest");
});

test("once the header pins, the open suggestion list slides behind it and the countdown bar", async ({ page }) => {
  // The real users table, tall enough to scroll; the paused clock keeps the countdown from firing.
  await page.clock.install();
  await gotoApp(page);
  await selectTable(page, "users");
  await choose(page, "5 s");
  await page.locator("#filter").click();
  await expect(page.locator("#filter-suggest")).toBeVisible();
  // Brings the table header a few pixels past the scroller's top, where it pins (WebKit
  // rounds scroll offsets to whole pixels).
  await page.evaluate(() => {
    const main = document.getElementById("main") as HTMLElement;
    const thead = document.getElementById("thead") as HTMLElement;
    main.scrollBy(0, thead.getBoundingClientRect().top - main.getBoundingClientRect().top + 4);
  });
  await expect(page.locator("#main")).toHaveClass(/header-stuck/);
  // Names what is on top where the list crosses the bar and where it crosses the header.
  const onTop = () =>
    page.evaluate(() => {
      const box = (id: string) => (document.getElementById(id) as HTMLElement).getBoundingClientRect();
      const bar = box("load-bar");
      const list = box("filter-suggest");
      const th = (document.querySelector("#data-table thead th") as HTMLElement).getBoundingClientRect();
      const name = (y: number) => {
        const hit = document.elementFromPoint(list.left + list.width / 2, y);
        if (hit?.closest("#filter-suggest")) return "filter-suggest";
        if (hit?.closest("th")) return "th";
        return hit?.closest("[id]")?.id ?? hit?.tagName ?? null;
      };
      const headerTop = Math.max(bar.bottom, list.top, th.top);
      const headerBottom = Math.min(list.bottom, th.bottom);
      return {
        atBar: list.top <= bar.top && list.bottom >= bar.bottom ? name(bar.top + 1) : "no overlap",
        atHeader: headerBottom - headerTop > 2 ? name((headerTop + headerBottom) / 2) : "no overlap",
      };
    });
  await expect.poll(onTop).toEqual({ atBar: "load-bar", atHeader: "th" });
});
