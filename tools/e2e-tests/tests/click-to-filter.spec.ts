import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

test("clicking a cell's filter button composes and submits an exact-match filter", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstStatusCell = page.locator('#tbody tr').first().locator('td[data-col="status"]');
  const value = await firstStatusCell.locator(".cell-text").textContent();
  await firstStatusCell.hover();
  await firstStatusCell.locator(".filter-eq").click();

  await expect(page.locator("#filter")).toHaveValue(`status = ${value}`);
  const statusCells = page.locator('#tbody td[data-col="status"] .cell-text');
  await expect
    .poll(async () => {
      const values = await statusCells.allTextContents();
      return values.length > 0 && values.every((v) => v === value);
    })
    .toBe(true);
});

test("clicking a null cell's filter button composes IS NULL", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const nullAgeButton = page
    .locator('#tbody td[data-col="age"] button.filter-eq.only-action')
    .first();
  await expect(nullAgeButton).toHaveAttribute("aria-label", "filter by null");
  await nullAgeButton.hover();
  await nullAgeButton.click();

  await expect(page.locator("#filter")).toHaveValue("age IS NULL");
  const ageCells = page.locator('#tbody td[data-col="age"] .cell-text');
  await expect
    .poll(async () => {
      const values = await ageCells.allTextContents();
      return values.length > 0 && values.every((v) => v === "∅");
    })
    .toBe(true);
});

test("a value containing a space is quoted in the composed filter", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  // Product names are "<buzzword> <noun>" (tools/seed-gen) — always
  // multi-word, so the first row is guaranteed to exercise quoting.
  const firstNameCell = page.locator('#tbody tr').first().locator('td[data-col="name"]');
  const value = await firstNameCell.locator(".cell-text").textContent();
  expect(value).toContain(" ");
  await firstNameCell.hover();
  await firstNameCell.locator(".filter-eq").click();

  await expect(page.locator("#filter")).toHaveValue(`name = '${value}'`);
  await expect(page.locator("#error")).toBeEmpty();
  const nameCells = page.locator('#tbody td[data-col="name"] .cell-text');
  await expect
    .poll(async () => {
      const values = await nameCells.allTextContents();
      return values.length > 0 && values.every((v) => v === value);
    })
    .toBe(true);
});

test("a jsonb cell round-trips through the URL as a shareable filter", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "payments");
  // gateway_response holds the seed's largest jsonb values — the case where
  // click-to-filter puts a substantial value in the address bar. Take the
  // biggest one on the page, not just the first row's.
  const lengths = await page
    .locator('#tbody td[data-col="gateway_response"] .cell-text')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").length));
  const cell = page
    .locator('#tbody td[data-col="gateway_response"]')
    .nth(lengths.indexOf(Math.max(...lengths)));
  await cell.hover();
  await cell.locator(".filter-eq").click();
  await waitForIdle(page); // syncUrl() only runs once loadData() resolves
  await expect(page.locator("#error")).toBeEmpty();

  const applied = await page.locator("#filter").inputValue();
  const url = new URL(page.url());
  expect(url.searchParams.get("filter")).toBe(applied);
  // Percent-encoding inflates it, but the DSL's own 1024-byte cap keeps the
  // whole URL far below the ~8KB request line nginx/Apache accept by default.
  expect(url.toString().length).toBeLessThan(2000);

  await gotoApp(page, url.search); // the link, opened cold
  await expect(page.locator("#filter")).toHaveValue(applied);
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr")).toHaveCount(1);
});

test("clicking a cell too long for the DSL cap fails closed, sending no request", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "support_tickets");
  const dataRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/tables/data")) dataRequests.push(r.url());
  });

  // support_tickets.description is the one seeded column exceeding the
  // parser's 1024-byte limit; pick the longest one actually on this page.
  const lengths = await page
    .locator('#tbody td[data-col="description"] .cell-text')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").length));
  const longest = Math.max(...lengths);
  expect(longest).toBeGreaterThan(1024); // guards against seed drift below the cap
  const cell = page
    .locator('#tbody td[data-col="description"]')
    .nth(lengths.indexOf(longest));

  await cell.hover();
  await cell.locator(".filter-eq").click();

  // Rejected client-side by parseFilterDsl, so nothing is fetched, nothing
  // is applied, and the oversize value never reaches the URL.
  await expect(page.locator("#error")).toHaveText(/filter too long \(max 1024 bytes\)/);
  expect(dataRequests).toEqual([]);
  expect(new URL(page.url()).searchParams.has("filter")).toBe(false);
  // The previous view is intact, not wedged (R5).
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});
