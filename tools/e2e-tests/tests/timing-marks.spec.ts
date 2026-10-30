import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { goBack, gotoApp, selectTable, waitForIdle, waitForTable } from "./support/helpers";

type Mark = { count: number; reason: string | undefined };

function readMark(page: Page, name: string): Promise<Mark> {
  return page.evaluate((full) => {
    const marks = performance.getEntriesByName(full, "mark") as PerformanceMark[];
    const last = marks.at(-1);
    return { count: marks.length, reason: (last?.detail as { reason?: string } | null)?.reason };
  }, `ashurbanipal:${name}`);
}

test("start-up leaves one of each timing mark, the load ones tagged boot", async ({ page }) => {
  await gotoApp(page);
  expect(await readMark(page, "scope-settled")).toEqual({ count: 1, reason: undefined });
  expect(await readMark(page, "tables-listed")).toEqual({ count: 1, reason: undefined });
  await expect.poll(() => readMark(page, "rows-rendered")).toEqual({ count: 1, reason: "boot" });
  expect(await readMark(page, "load-start")).toEqual({ count: 1, reason: "boot" });
});

test("a chip, the pager and Back each replace the load marks with their own reason", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await expect.poll(() => readMark(page, "rows-rendered")).toEqual({ count: 1, reason: "chip" });
  expect(await readMark(page, "load-start")).toEqual({ count: 1, reason: "chip" });

  await page.locator("#next").click();
  await waitForIdle(page);
  await expect.poll(() => readMark(page, "rows-rendered")).toEqual({ count: 1, reason: "page" });

  await goBack(page);
  await goBack(page);
  await waitForTable(page, "_conformance_meta");
  await expect.poll(() => readMark(page, "rows-rendered")).toEqual({ count: 1, reason: "history" });
  expect(await readMark(page, "tables-listed")).toEqual({ count: 1, reason: undefined });
});
