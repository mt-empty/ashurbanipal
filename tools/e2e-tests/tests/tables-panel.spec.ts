import { expect, type Page, test } from "./support/fixtures";
import {
  apiCall,
  gotoApp,
  hideTablesPanel,
  holdRequests,
  reloadApp,
  selectTable,
  tableData,
  waitForTable,
} from "./support/helpers";
import { gotoJoin, ORDERS_USERS_CANONICAL } from "./support/join";

const KEY = "ashurbanipal_tables_panel";
const toggle = (page: Page) => page.locator("#tables-panel-toggle");
const panelMode = (page: Page) => page.evaluate(() => document.documentElement.dataset.tablesPanel);
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const row = (page: Page, table: string) => page.locator(`#tables [data-table="${table}"]`);
const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};

test("the table list opens as a side panel, one row per table", async ({ page }) => {
  await gotoApp(page);
  expect(await panelMode(page)).toBe("open");
  const rows = page.locator("#tables [data-table]");
  await expect(page.locator("#tables-heading")).toHaveText(`Tables · ${await rows.count()}`);
  for (const r of await rows.all()) await expect(r).toBeVisible();
  await expect(page.locator("#tables-more-item")).toBeHidden();
  await expect(page.locator("#joins-heading")).toHaveText("Joins");
  // One row per line, and the filter starts right of the panel.
  const [a, b] = [await box(page, '[data-table="audit_log"]'), await box(page, '[data-table="events"]')];
  expect(b.y).toBeGreaterThan(a.y);
  expect(b.x).toBe(a.x);
  const panel = await box(page, "#tables-panel");
  expect((await box(page, "#filter")).x).toBeGreaterThan(panel.x + panel.width);
});

test("hiding the panel brings the chips back above the filter, and the choice is remembered", async ({ page }) => {
  await gotoApp(page);
  await toggle(page).click();
  expect(await panelMode(page)).toBe("hidden");
  await expect(toggle(page)).toHaveAccessibleName("Show the table list");
  await expect(toggle(page)).toBeFocused();
  const chip = await box(page, '[data-table="audit_log"]');
  expect(chip.y + chip.height).toBeLessThan((await box(page, "#filter")).y);
  await expect(page.locator("#tables-heading")).toBeHidden();
  await expect(page.locator("#joins-heading")).toBeHidden();
  expect(await stored(page)).toBe("hidden");

  await reloadApp(page);
  expect(await panelMode(page)).toBe("hidden");
  await toggle(page).click();
  expect(await panelMode(page)).toBe("open");
  await expect(toggle(page)).toHaveAccessibleName("Hide the table list");
  await reloadApp(page);
  expect(await panelMode(page)).toBe("open");
});

test("a narrow window starts with the panel hidden and stores nothing", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await gotoApp(page);
  expect(await panelMode(page)).toBe("hidden");
  expect(await stored(page)).toBeNull();
});

test("a stored choice wins at any width, and a bad one falls back to the width's default (R5)", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate((key) => localStorage.setItem(key, "sideways"), KEY);
  await reloadApp(page);
  expect(await panelMode(page)).toBe("open");
  await page.setViewportSize({ width: 800, height: 720 });
  await reloadApp(page);
  expect(await panelMode(page)).toBe("hidden");
  await page.evaluate((key) => localStorage.setItem(key, "open"), KEY);
  await reloadApp(page);
  expect(await panelMode(page)).toBe("open");
});

for (const mode of ["open", "hidden"]) {
  test(`Tab reaches the toggle, then the tables in order (${mode})`, async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "WebKit's Tab skips links unless the user turns on full keyboard access");
    if (mode === "hidden") await hideTablesPanel(page);
    await gotoApp(page);
    await page.locator("#theme-toggle").focus();
    await page.keyboard.press("Tab");
    await expect(toggle(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row(page, "_conformance_meta")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row(page, "audit_log")).toBeFocused();
  });

  test(`the load bar, grid and pager line up with the filter (${mode})`, async ({ page }) => {
    if (mode === "hidden") await hideTablesPanel(page);
    await gotoApp(page);
    await selectTable(page, "orders");
    const left = (await box(page, "#filter-form")).x;
    expect((await box(page, "#data-table")).x).toBe(left);
    expect((await box(page, "#pager")).x).toBe(left);
    const release = await holdRequests(page, tableData);
    await row(page, "users").click();
    await expect(page.locator("#load-bar")).toHaveAttribute("data-state", "loading");
    expect((await box(page, "#load-bar")).x).toBe(left);
    release();
    await waitForTable(page, "users");
  });

  test(`a table's spinner takes its count's place without moving the list (${mode})`, async ({ page }) => {
    if (mode === "hidden") await hideTablesPanel(page);
    await gotoApp(page);
    const before = await box(page, '[data-table="users"]');
    const release = await holdRequests(page, tableData);
    await row(page, "users").click();
    await expect(row(page, "users").locator(".chip-spinner")).toBeVisible();
    expect(await box(page, '[data-table="users"]')).toEqual(before);
    release();
    await waitForTable(page, "users");
  });
}

test("on an engine without counts a row has no count cell, and its spinner still has room", async ({ page }) => {
  await page.route(apiCall("/sources"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const source of body.sources) source.engine = "sqlite";
    await route.fulfill({ response, json: body });
  });
  await hideTablesPanel(page);
  await gotoApp(page);
  await expect(row(page, "users").locator(".count")).toHaveCount(0);
  const before = await box(page, '[data-table="users"]');
  const release = await holdRequests(page, tableData);
  await row(page, "users").click();
  const spinner = row(page, "users").locator(".chip-spinner");
  await expect(spinner).toBeVisible();
  const s = await box(page, '[data-table="users"] .chip-spinner');
  expect(s.x + s.width).toBeLessThanOrEqual(before.x + before.width);
  expect(await box(page, '[data-table="users"]')).toEqual(before);
  release();
  await waitForTable(page, "users");
});

test("the panel stays at the left over a table scrolled sideways, and pins once the top bar scrolls away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.addInitScript((key) => localStorage.setItem(key, "open"), KEY);
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#main").evaluate((m) => m.scrollTo(m.scrollWidth, m.scrollHeight));
  const geometry = await page.evaluate(() => {
    const main = document.getElementById("main") as HTMLElement;
    const panel = (document.getElementById("tables-panel") as HTMLElement).getBoundingClientRect();
    const r = (document.querySelector('#tables [data-table="events"]') as HTMLElement).getBoundingClientRect();
    const th = [...document.querySelectorAll("#thead th")]
      .map((t) => t.getBoundingClientRect())
      .find((t) => t.left > panel.right);
    return {
      scrolledLeft: main.scrollLeft > 0,
      panelLeft: panel.left,
      panelTop: panel.top - main.getBoundingClientRect().top,
      rowOnTop: !!document.elementFromPoint(r.left + 10, r.top + r.height / 2)?.closest("#tables-panel"),
      headerOnTop: !!th && !!document.elementFromPoint(th.left + 5, th.top + 5)?.closest("#thead"),
    };
  });
  expect(geometry).toEqual({ scrolledLeft: true, panelLeft: 0, panelTop: 0, rowOnTop: true, headerOnTop: true });
});

test("a long list scrolls inside the panel and never makes a short table scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await gotoApp(page);
  await selectTable(page, "saved_reports");
  const panel = page.locator("#tables-panel");
  expect(await panel.evaluate((p) => p.scrollHeight > p.clientHeight)).toBe(true);
  expect(await page.locator("#main").evaluate((m) => m.scrollHeight <= m.clientHeight)).toBe(true);
  // The active row is scrolled into the panel's view.
  await selectTable(page, "users");
  const [p, r] = [await box(page, "#tables-panel"), await box(page, '[data-table="users"]')];
  expect(r.y + r.height).toBeLessThanOrEqual(p.y + p.height);
  await page.locator("#tables li.new-join button").scrollIntoViewIfNeeded();
  await expect(page.locator("#tables li.new-join button")).toBeInViewport();
});

test("a saved join in view is marked like the active table; an unsaved one is dashed in both modes", async ({
  page,
}) => {
  await page.addInitScript(
    (text) =>
      localStorage.setItem(
        "ashurbanipal_saved_joins",
        JSON.stringify({ [JSON.stringify(["primary", "public"])]: [{ name: "orders with users", text }] }),
      ),
    ORDERS_USERS_CANONICAL,
  );
  await gotoJoin(page, ORDERS_USERS_CANONICAL);
  await expect(page.locator("#joins-heading")).toHaveText("Joins · 1");
  await expect(page.locator("#tables li.join-chip.saved > button")).toHaveAttribute("aria-current", "true");

  await gotoJoin(page, "SELECT *\nFROM payments p\nLEFT JOIN orders o ON p.order_id = o.id");
  const unsaved = page.locator("#tables li.join-chip.unsaved button");
  await expect(unsaved).toHaveCSS("outline-style", "dashed");
  await expect(unsaved).toHaveCSS("border-top-width", "0px");
  // Reached by keyboard, it gets the same focus ring as every other entry.
  await page.locator("#tables li.join-chip.saved a").last().focus();
  await page.keyboard.press("Tab");
  await expect(unsaved).toBeFocused();
  await expect(unsaved).toHaveCSS("outline-style", "solid");
  await toggle(page).click();
  await expect(unsaved).toHaveCSS("border-top-style", "dashed");
  // Not bold: a proportional label would widen its chip and shift the ones after it.
  await expect(unsaved.locator(".chip-name")).toHaveCSS("font-weight", "400");
  await expect(page.locator("#tables li.save-link button")).toBeVisible();
});
