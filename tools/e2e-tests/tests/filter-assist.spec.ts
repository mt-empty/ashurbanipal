import { expect, test } from "@playwright/test";
import { applyFilter, gotoApp, selectTable, waitForIdle } from "./support/helpers";

const suggestions = (page: import("@playwright/test").Page) => page.locator("#filter-suggest-list button");

test("an operator list follows a column and a space", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status ");
  await expect(suggestions(page)).toHaveText(["=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"]);
  await page.locator("#filter").fill("status I");
  await expect(suggestions(page)).toHaveText(["ILIKE", "IS NULL", "IS NOT NULL"]);
});

test("accepting a column moves on to its operators", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").focus();
  await suggestions(page).filter({ hasText: /^status$/ }).click();
  await expect(page.locator("#filter")).toHaveValue("status ");
  await expect(suggestions(page).first()).toHaveText("=");
});

test("a value list follows an operator, from the column's common values", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = ");
  await expect(suggestions(page).filter({ hasText: /^completed$/ })).toHaveCount(1);
  await page.locator("#filter").fill("status = comp");
  await expect(suggestions(page)).toHaveText(["completed"]);
});

test("Tab accepts the first suggestion", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#filter").fill("category = ");
  await expect(suggestions(page).first()).toBeVisible();
  const first = await suggestions(page).first().textContent();
  await page.locator("#filter").press("Tab");
  await expect(page.locator("#filter")).toHaveValue(`category = ${first} `);
});

test("Enter submits what is typed even while a value list is open", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = comp");
  await expect(suggestions(page)).toHaveCount(1);
  await page.locator("#filter").press("Enter");
  await waitForIdle(page);
  expect(new URL(page.url()).searchParams.get("filter")).toBe("status = comp");
  await expect(page.locator("#filter-suggest")).toBeHidden();
});

test("an arrow key highlights a row and Enter then accepts it", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = comp");
  await expect(suggestions(page)).toHaveCount(1);
  await page.locator("#filter").press("ArrowDown");
  await page.locator("#filter").press("Enter");
  await expect(page.locator("#filter")).toHaveValue("status = completed ");
});

test("AND and OR are offered once a letter is typed after a finished condition", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed ");
  await expect(page.locator("#filter-suggest")).toBeHidden();
  await page.locator("#filter").fill("status = completed A");
  await expect(suggestions(page)).toHaveText(["AND"]);
});

test("nothing is suggested once the text left the grammar", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed oops ");
  await expect(page.locator("#filter-suggest")).toBeHidden();
});

const parts = (page: import("@playwright/test").Page, cls: string) => page.locator(`#filter-hl-text .${cls}`);

test("the typed filter is coloured by part", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed AND total_cents > 5000");
  await expect(parts(page, "t-column")).toHaveText(["status", "total_cents"]);
  await expect(parts(page, "t-op")).toHaveText(["=", ">"]);
  await expect(parts(page, "t-keyword")).toHaveText(["AND"]);
  await expect(parts(page, "t-value")).toHaveText(["completed", "5000"]);
  await expect(parts(page, "t-err")).toHaveCount(0);
});

test("the part where the filter stops making sense is underlined; unfinished typing is not", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed oops");
  await expect(parts(page, "t-err")).toHaveText("oops");
  await page.locator("#filter").fill("status =");
  await expect(parts(page, "t-err")).toHaveCount(0);
  await page.locator("#filter").fill("status = 'open");
  await expect(parts(page, "t-err")).toHaveCount(0);
});

test("the coloured copy sits exactly under the input's own text", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed");
  const box = await page.evaluate(() => {
    const input = document.getElementById("filter") as HTMLInputElement;
    const first = document.querySelector("#filter-hl-text span") as HTMLElement;
    const i = input.getBoundingClientRect();
    const f = first.getBoundingClientRect();
    return { dx: f.left - (i.left + Number.parseFloat(getComputedStyle(input).paddingLeft)), dy: f.top + f.height / 2 - (i.top + i.height / 2) };
  });
  expect(Math.abs(box.dx)).toBeLessThan(1.5);
  expect(Math.abs(box.dy)).toBeLessThan(2);
});

test("a filter too long for the field falls back to the input's own text", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const filter = page.locator("#filter");
  await filter.fill(`status = ${"x".repeat(300)}`);
  await expect(page.locator("#filter-wrap")).toHaveClass(/plain/);
  await expect(page.locator("#filter-hl")).toBeHidden();
  const color = await filter.evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe("rgba(0, 0, 0, 0)");
  await filter.fill("status = x");
  await expect(page.locator("#filter-wrap")).not.toHaveClass(/plain/);
  await expect(page.locator("#filter-hl")).toBeVisible();
});

test("a filter written by click-to-filter is coloured too", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('#tbody td[data-col="status"]').first().hover();
  await page.locator('#tbody td[data-col="status"] button.filter-eq').first().click({ force: true });
  await waitForIdle(page);
  await expect(parts(page, "t-column")).toHaveText(["status"]);
  await expect(parts(page, "t-op")).toHaveText(["="]);
});

test("a typed filter still applies end to end", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  await expect(page.locator("#error")).toBeEmpty();
});

test("the suggestion popup is exposed as a combobox with the highlighted row active", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const input = page.locator("#filter");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.focus();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", "filter-suggest-0");
  await expect(suggestions(page).first()).toHaveAttribute("aria-selected", "true");
  await input.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
});

test("a huge paste neither throws nor leaves stale colours behind", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed");
  await page.locator("#filter").fill("a ".repeat(100_000));
  await expect(page.locator("#filter-wrap")).toHaveClass(/plain/);
  await expect(page.locator("#filter-hl-text span")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("leading spaces are not underlined as an error", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("  status = completed");
  await expect(page.locator("#filter-hl-text .t-err")).toHaveCount(0);
});
