import { expect, type Page, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";

// Headless engines give scrollbars no layout width; Chromium does once
// Playwright's --hide-scrollbars is dropped, so this spec runs on Chromium only.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const mainBox = (page: Page) =>
  page.locator("#main").evaluate((el) => ({
    gutter: (el as HTMLElement).offsetWidth - el.clientWidth,
    overflows: el.scrollHeight > el.clientHeight,
  }));

test("the chip list keeps its width between a short table and a tall one", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "saved_reports");
  expect((await mainBox(page)).overflows).toBe(false);
  const short = await page.locator("#tables").evaluate((el) => el.clientWidth);
  await selectTable(page, "orders");
  await expect.poll(async () => (await mainBox(page)).overflows).toBe(true);
  expect((await mainBox(page)).gutter).toBeGreaterThan(0);
  expect(await page.locator("#tables").evaluate((el) => el.clientWidth)).toBe(short);
});
