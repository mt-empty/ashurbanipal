import { test, expect, type Page } from "@playwright/test";
import { applyFilter, gotoApp, selectTable, waitForIdle } from "./support/helpers";

async function headerBoxes(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("thead th[data-col]")].map((th) => {
        const r = th.getBoundingClientRect();
        return [th.dataset.col!, { x: r.x, width: r.width }];
      }),
    ),
  );
}

test("a filter that drops the widest values leaves every column where it was", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const before = await headerBoxes(page);
  await applyFilter(page, "name = 'Organic Cap'");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const after = await headerBoxes(page);
  for (const [name, box] of Object.entries(before)) {
    expect(after[name].x, name).toBeCloseTo(box.x, 0);
    expect(after[name].width, name).toBeCloseTo(box.width, 0);
  }
});

test("a sort never narrows a column", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const before = await headerBoxes(page);
  await page.locator('th[data-col="description"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  const after = await headerBoxes(page);
  for (const [name, box] of Object.entries(before)) {
    expect(after[name].width, name).toBeGreaterThanOrEqual(box.width - 0.5);
  }
});

test("refresh lets columns shrink back to their content", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  const wide = (await headerBoxes(page)).description.width;
  await applyFilter(page, "name = 'Organic Cap'");
  expect((await headerBoxes(page)).description.width).toBeCloseTo(wide, 0);
  await page.locator("#refresh").click();
  await waitForIdle(page);
  await expect.poll(async () => (await headerBoxes(page)).description.width).toBeLessThan(wide);
});
