import { test, expect } from "@playwright/test";
import { gotoApp } from "./support/helpers";

async function dragHandleTo(page: import("@playwright/test").Page, targetX: number) {
  const handle = page.locator("#sidebar-resize-handle");
  const box = await handle.boundingBox();
  if (!box) throw new Error("handle not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, box.y + box.height / 2);
  await page.mouse.up();
}

test("dragging the handle resizes the sidebar live", async ({ page }) => {
  await gotoApp(page);
  const before = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  await dragHandleTo(page, before + 100);
  const after = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 50);
});

test("sidebar width persists across a fresh visit", async ({ page }) => {
  await gotoApp(page);
  await dragHandleTo(page, 350);

  await gotoApp(page); // bare URL, forces restore-from-localStorage before first paint
  const width = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(300);
  expect(width).toBeLessThan(400);
});

test("dragging past the min/max bounds clamps rather than tracking the raw pointer", async ({
  page,
}) => {
  await gotoApp(page);
  await dragHandleTo(page, 5); // far left of MIN_W
  const min = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(min).toBeGreaterThanOrEqual(180);

  await dragHandleTo(page, 2000); // far right of MAX_W
  const max = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(max).toBeLessThanOrEqual(500);
});

test("corrupted localStorage width falls back to the default silently", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem("ashurbanipal_sidebar_w", "not a number"));

  await gotoApp(page);
  await expect(page.locator("#current")).not.toHaveText("—");
  await expect(page.locator("#error")).toBeEmpty();
  const width = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBe(220);
});

test("out-of-range persisted width falls back to the default", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => localStorage.setItem("ashurbanipal_sidebar_w", "9999"));

  await gotoApp(page);
  const width = await page.locator("nav").evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBe(220);
});
