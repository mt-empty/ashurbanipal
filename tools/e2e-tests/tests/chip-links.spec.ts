import { expect, type Locator, type Page, test } from "@playwright/test";
import { APP_PATH, gotoApp, selectTable, waitForIdle } from "./support/helpers";
import {
  expandTableChips,
  ORDERS_USERS,
  ORDERS_USERS_CANONICAL,
  openJoinOverlay,
  showResult,
  writeSql,
} from "./support/join";

// Table chips and inactive saved-join chips are real links: a plain click
// switches in place, every other click is the browser's to open a new tab.

async function hrefOf(chip: Locator): Promise<URL> {
  return new URL(await chip.evaluate((a) => (a as HTMLAnchorElement).href));
}

// A marker on window survives an in-place switch and is gone after a reload.
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });
}

async function documentKept(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);
}

async function activeTable(page: Page): Promise<string | null> {
  return page.locator("#tables [data-table].active").getAttribute("data-table");
}

// Clicks `chip` with a new-tab gesture and returns that tab once `current` is in view there.
async function openInNewTab(
  page: Page,
  chip: Locator,
  options: Parameters<Locator["click"]>[0],
  current: string,
): Promise<Page> {
  const opened = page.context().waitForEvent("page");
  await chip.click(options);
  const tab = await opened;
  await tab.locator("#current").getByText(current, { exact: true }).waitFor();
  await waitForIdle(tab);
  return tab;
}

test("a table chip links to its table in the current schema", async ({ page }) => {
  await gotoApp(page);
  const href = await hrefOf(page.locator('#tables [data-table="users"]'));
  expect(href.pathname).toBe(APP_PATH);
  expect(href.searchParams.get("table")).toBe("users");
  expect(href.searchParams.get("schema")).toBe(await page.locator("#schema-select").inputValue());
  expect(href.searchParams.has("filter")).toBe(false);
});

test("a plain click and Enter switch the table without reloading the page", async ({ page }) => {
  await gotoApp(page);
  await markDocument(page);
  await selectTable(page, "users");
  expect(await documentKept(page)).toBe(true);
  expect(new URL(page.url()).searchParams.get("table")).toBe("users");

  await page.locator('#tables [data-table="orders"]').focus();
  await page.keyboard.press("Enter");
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await waitForIdle(page);
  expect(await documentKept(page)).toBe(true);
});

const NEW_TAB_GESTURES: [string, Parameters<Locator["click"]>[0]][] = [
  ["Ctrl/Cmd-click", { modifiers: ["ControlOrMeta"] }],
  ["middle-click", { button: "middle" }],
];

for (const [gesture, options] of NEW_TAB_GESTURES) {
  test(`${gesture} on a table chip opens it in a new tab and leaves this one alone`, async ({ page }) => {
    await gotoApp(page);
    const before = await activeTable(page);
    expect(before).not.toBe("users");
    await openInNewTab(page, page.locator('#tables [data-table="users"]'), options, "users");

    expect(await activeTable(page)).toBe(before);
    expect(new URL(page.url()).searchParams.get("table")).not.toBe("users");
  });
}

test("an inactive saved-join chip links to its join; the one in view stays an edit button", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-name").fill("kept");
  await showResult(page);
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip.saved > button", { hasText: "kept" })).toBeVisible();

  await selectTable(page, "users");
  await expandTableChips(page);
  const link = page.locator("#tables li.join-chip.saved > a", { hasText: "kept" });
  const href = await hrefOf(link);
  expect(href.searchParams.get("table")).toBe("orders");
  expect(href.searchParams.get("join")).toBe(ORDERS_USERS_CANONICAL);

  const tab = await openInNewTab(page, link, { modifiers: ["ControlOrMeta"] }, "orders o ⟕ users u");
  await expect(tab.locator("th.band")).toHaveText(["orders o", "users u"]);
  await expect(page.locator("#current").getByText("users", { exact: true })).toBeVisible();
});
