import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";

// Every headless engine here uses overlay scrollbars; Chromium shows classic
// ones once Playwright's --hide-scrollbars is dropped.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("the chip list keeps its width between a short table and a tall one", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "no classic scrollbars in this engine's headless mode");
  await gotoApp(page);
  await selectTable(page, "saved_reports");
  const short = await page.locator("#tables").evaluate((el) => el.clientWidth);
  await selectTable(page, "orders");
  await expect.poll(() => page.locator("#main").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await page.locator("#tables").evaluate((el) => el.clientWidth)).toBe(short);
});
