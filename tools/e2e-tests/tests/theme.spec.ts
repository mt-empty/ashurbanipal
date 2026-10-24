import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, reloadApp } from "./support/helpers";

test.use({ colorScheme: "light" });

const toggle = (page: Page) => page.locator("#theme-toggle");
// Body text is CanvasText, which follows the used color-scheme that every light-dark() token reads.
const textColor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).color);

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", String(theme === "dark"));
  expect(await page.evaluate(() => localStorage.getItem("ashurbanipal_theme"))).toBe(theme);
}

test("the theme toggle switches theme, and the choice survives a reload", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const light = await textColor(page);

  await toggle(page).click();
  await expectTheme(page, "dark");
  expect(await textColor(page)).not.toBe(light);

  // On load only the inline <head> script sets data-theme, from the stored choice.
  await reloadApp(page);
  await expectTheme(page, "dark");

  await toggle(page).click();
  await expectTheme(page, "light");
  expect(await textColor(page)).toBe(light);
});
