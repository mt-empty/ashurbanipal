import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, holdRequests, selectTable, tableData, waitForIdle, waitForTable } from "./support/helpers";

const expectBarIdle = (page: Page) => expect(page.locator("#load-bar")).not.toHaveAttribute("data-state", /.*/);

test("a fast fetch shows no bar, no dimming and no loading text", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    new MutationObserver(() => {
      const bar = document.getElementById("load-bar")?.dataset.state;
      if (bar) w.seen.push(bar);
      if (document.getElementById("data-table")?.hasAttribute("data-slow")) w.seen.push("slow");
      if (document.getElementById("status")?.textContent === "loading…") w.seen.push("loading…");
    }).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  await page.locator("#refresh").click();
  await waitForIdle(page);
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
});

test("a slow fetch shows the bar, dims the rows, and clears when it lands", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const release = await holdRequests(page, tableData);
  await page.locator('#tables [data-table="users"]').click();

  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");
  await expect(page.locator("#data-table")).toHaveAttribute("data-slow", "");
  await expect(page.locator("#data-table")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#status")).toHaveText("loading…");

  release();
  await waitForTable(page, "users");
  await expectBarIdle(page);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-slow", "");
  await expect(page.locator("#status")).toHaveText("");
});

test("overlapping fetches keep the bar until the last one settles", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  let calls = 0;
  const releases: Array<() => void> = [];
  await page.route(tableData, async (route) => {
    const n = calls++;
    await new Promise<void>((r) => (releases[n] = r));
    await route.continue();
  });

  await page.locator('#tables [data-table="users"]').click();
  await page.locator('#tables [data-table="products"]').click();
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");

  releases[0]();
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");

  releases[1]();
  await waitForTable(page, "products");
  await expectBarIdle(page);
});

test("a failed slow fetch shows the error and clears the bar", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const release = await holdRequests(page, tableData, (route) => route.abort("failed"));
  await page.locator('#tables [data-table="users"]').click();
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");

  release();
  await expect(page.locator("#error")).not.toBeEmpty();
  await expectBarIdle(page);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-slow", "");
});
