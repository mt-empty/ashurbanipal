import { expect, type Page, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";

test.use({ realFades: true });

/** The most view-transition animations seen in any frame since the last call, which first waits out any still running. */
async function startCountingFades(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition")).length,
      ),
    )
    .toBe(0);
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

test("under reduced motion the record dialog opens without its cross-fade (R15)", async ({ page }) => {
  await gotoApp(page);
  test.skip(!(await page.evaluate(() => "startViewTransition" in document)), "no view transitions in this browser");
  await selectTable(page, "orders");
  // The dialog opens inside startViewTransition, so its fade starts a frame or two after it is visible; closing
  // sooner can cancel the fade before it is ever seen.
  const openRecord = async (settled: () => Promise<unknown>) => {
    await page.locator("#tbody tr").first().locator(".record-btn").click();
    await expect(page.locator("#record-dialog")).toBeVisible();
    await settled();
    await page.keyboard.press("Escape");
    await expect(page.locator("#record-dialog")).toBeHidden();
  };

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await startCountingFades(page);
  await openRecord(() =>
    expect.poll(() => fadesSeen(page), "the cross-fade runs with normal motion").toBeGreaterThan(0),
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await startCountingFades(page);
  await openRecord(() =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))),
  );
  expect(await fadesSeen(page)).toBe(0);
});

test("under reduced motion a view switch jumps to the top instead of scrolling there (R15)", async ({ page }) => {
  // The scroll's own events can't tell smooth from instant (the new grid fires some too), so record what was asked for.
  await page.addInitScript(() => {
    const w = window as unknown as { scrollBehaviors: string[] };
    w.scrollBehaviors = [];
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (this: Element, ...args: [ScrollToOptions?]) {
      if (this.id === "main") w.scrollBehaviors.push(args[0]?.behavior ?? "");
      return scrollTo.apply(this, args as never);
    } as typeof scrollTo;
  });
  await gotoApp(page);
  const lastBehavior = () =>
    page.evaluate(() => (window as unknown as { scrollBehaviors: string[] }).scrollBehaviors.at(-1));

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await selectTable(page, "users");
  expect(await lastBehavior()).toBe("smooth");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await selectTable(page, "orders");
  expect(await lastBehavior()).toBe("instant");
});
