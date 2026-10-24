import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";

test.use({ realFades: true });

/** The most view-transition animations seen in any frame since the last call. */
async function startCountingFades(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { fades: number };
    w.fades = 0;
    const tick = () => {
      const now = document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")).length;
      w.fades = Math.max(w.fades, now);
      requestAnimationFrame(tick);
    };
    tick();
  });
}
const fadesSeen = (page: Page) => page.evaluate(() => (window as unknown as { fades: number }).fades);

test("under reduced motion a table switch swaps without its cross-fade (R15)", async ({ page }) => {
  await gotoApp(page);
  test.skip(!(await page.evaluate(() => "startViewTransition" in document)), "no view transitions in this browser");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await startCountingFades(page);
  await selectTable(page, "users");
  expect(await fadesSeen(page), "the cross-fade runs with normal motion").toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await startCountingFades(page);
  await selectTable(page, "orders");
  expect(await fadesSeen(page)).toBe(0);
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});
