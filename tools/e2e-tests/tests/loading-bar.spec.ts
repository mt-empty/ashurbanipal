import { test, expect, type Page } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

const DATA = "**/api/tables/data*";

/** Holds every /tables/data response until the returned function is called. */
async function holdData(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(DATA, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

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
  const release = await holdData(page);
  await page.locator('#tables [data-table="users"]').click();

  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");
  await expect(page.locator("#data-table")).toHaveAttribute("data-slow", "");
  await expect(page.locator("#data-table")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#status")).toHaveText("loading…");

  release();
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator("#load-bar")).not.toHaveAttribute("data-state", /.*/);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-slow", "");
  await expect(page.locator("#status")).toHaveText("");
});

test("overlapping fetches keep the bar until the last one settles", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  let calls = 0;
  const releases: Array<() => void> = [];
  await page.route(DATA, async (route) => {
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
  await page.locator("#current").getByText("products", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator("#load-bar")).not.toHaveAttribute("data-state", /.*/);
});

test("a failed slow fetch shows the error and clears the bar", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(DATA, async (route) => {
    await gate;
    await route.abort("failed");
  });
  await page.locator('#tables [data-table="users"]').click();
  await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");

  release();
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#load-bar")).not.toHaveAttribute("data-state", /.*/);
  await expect(page.locator("#data-table")).not.toHaveAttribute("data-slow", "");
});
