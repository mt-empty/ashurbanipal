import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, waitForIdle } from "./support/helpers";

test.use({ colorScheme: "light" });

const toggle = (page: Page) => page.locator("#theme-toggle");
// Body text is CanvasText, which follows the used color-scheme that every light-dark() token reads.
const textColor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).color);

test("the theme toggle switches theme, and the choice survives a reload", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const light = await textColor(page);

  await toggle(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  expect(await textColor(page)).not.toBe(light);
  expect(await page.evaluate(() => localStorage.getItem("ashurbanipal_theme"))).toBe("dark");

  // On load only the inline <head> script sets data-theme, from the stored choice.
  await page.reload();
  await waitForIdle(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  await toggle(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect(await textColor(page)).toBe(light);
  expect(await page.evaluate(() => localStorage.getItem("ashurbanipal_theme"))).toBe("light");
});
