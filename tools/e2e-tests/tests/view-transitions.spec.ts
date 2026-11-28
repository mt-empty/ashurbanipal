import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

// A view transition that the next one interrupts is skipped, and its `ready` promise rejects.
// Skipping every transition at once makes that happen on each redraw, not just under a lucky race.
test("a skipped view transition leaves no unhandled rejection", async ({ page }) => {
  await page.addInitScript(() => {
    const start = document.startViewTransition?.bind(document);
    if (!start) return;
    document.startViewTransition = ((update: ViewTransitionUpdateCallback) => {
      const transition = start(update);
      transition.skipTransition();
      return transition;
    }) as typeof document.startViewTransition;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await gotoApp(page);
  test.skip(!(await page.evaluate(() => "startViewTransition" in document)), "no view transitions in this browser");
  await selectTable(page, "products");
  await page.locator('th[data-col="price"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  await expect(page.locator('th[data-col="price"]')).toHaveAttribute("aria-sort", "ascending");
  await page.locator("#tbody .record-btn").first().click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  expect(errors).toEqual([]);
});
