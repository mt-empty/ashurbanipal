import { expect, test, type Page } from "./support/fixtures";
import { applyFilter, gotoApp, selectTable, waitForIdle } from "./support/helpers";

const suggestions = (page: Page) => page.locator("#filter-suggest-list button");

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

test("Enter on a cleared filter resets the view instead of completing a column", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "status = completed");
  const input = page.locator("#filter");
  await input.fill("");
  await expect(suggestions(page).first()).toBeVisible();
  await input.press("Enter");
  await waitForIdle(page);
  await expect(input).toHaveValue("");
  expect(new URL(page.url()).searchParams.get("filter")).toBeNull();
  await expect(page.locator("#filter-suggest")).toBeHidden();
});

test("Enter submits a part-typed column instead of completing it", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const input = page.locator("#filter");
  await input.fill("sta");
  await expect(suggestions(page)).toHaveText(["status"]);
  await input.press("Enter");
  // Only a submit runs parseFilterDsl, so the parse error proves Enter submitted.
  await expect(page.locator("#error")).toContainText("expected operator");
  await expect(input).toHaveValue("sta");
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

const parts = (page: Page, cls: string) => page.locator(`#filter-hl-text .${cls}`);

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
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.press("ArrowDown");
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

test("the coloured copy follows the field's width, not just the window's", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed AND id > 10");
  await expect(page.locator("#filter-wrap")).not.toHaveClass(/plain/);
  // A width change without a window resize, as a scrollbar appearing causes.
  await page.locator("#filter-wrap").evaluate((el) => {
    el.style.flex = "none";
    el.style.width = "80px";
  });
  await expect(page.locator("#filter-wrap")).toHaveClass(/plain/);
  await page.locator("#filter-wrap").evaluate((el) => {
    el.style.flex = "";
    el.style.width = "";
  });
  await expect(page.locator("#filter-wrap")).not.toHaveClass(/plain/);
});

test("leading spaces are not underlined as an error", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("  status = completed");
  await expect(page.locator("#filter-hl-text .t-err")).toHaveCount(0);
});

// What is on top at a point just inside the popup's left edge, at the given y.
const topmostAt = (page: Page, y: number) =>
  page.evaluate((y) => {
    const box = document.getElementById("filter-suggest")?.getBoundingClientRect();
    const el = box && document.elementFromPoint(box.left + 4, y);
    return el?.closest("#filter-suggest") ? "popup" : el?.closest("thead") ? "header" : "other";
  }, y);

test("the suggestion list covers the table header at rest and slides behind it once pinned", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status ");
  const popup = page.locator("#filter-suggest");
  await expect(popup).toBeVisible();
  const th = page.locator("#thead th").first();
  const box = async (l: typeof popup) => l.evaluate((el) => el.getBoundingClientRect().toJSON());
  // At rest the list overlaps the not-yet-pinned header, and is on top of it.
  const rest = await box(popup);
  const restHeader = await box(th);
  expect(rest.top).toBeLessThan(restHeader.bottom);
  expect(rest.bottom).toBeGreaterThan(restHeader.top);
  expect(await topmostAt(page, restHeader.top + 8)).toBe("popup");
  // Scrolling moves it with the field and never closes it.
  await page.locator("#main").evaluate((el) => el.scrollTo(0, 60));
  await expect(popup).toBeVisible();
  expect(Math.round(rest.top - (await box(popup)).top)).toBe(60);
  // Once the header is pinned, the list passes behind it.
  await page.locator("#main").evaluate((el, to) => el.scrollTo(0, to), restHeader.top + 40);
  await expect(page.locator("#main")).toHaveClass(/header-stuck/);
  const pinned = await box(th);
  expect(await topmostAt(page, pinned.bottom - 4)).toBe("header");
  await expect(page.locator("#filter")).toHaveAttribute("aria-expanded", "true");
});

test("a word still being typed is not underlined as an error", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status I");
  await expect(page.locator("#filter-hl-text .t-err")).toHaveCount(0);
});

test("operators are not offered after a word that is not a column", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("zzz ");
  await expect(page.locator("#filter-suggest")).toBeHidden();
  await page.locator("#filter").fill("status ");
  await expect(suggestions(page).first()).toHaveText("=");
});

test("only a word that cannot become valid is underlined", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#filter").fill("status = completed AN");
  await expect(page.locator("#filter-hl-text .t-err")).toHaveCount(0);
  await page.locator("#filter").fill("status Q");
  await expect(page.locator("#filter-hl-text .t-err")).toHaveText("Q");
});
