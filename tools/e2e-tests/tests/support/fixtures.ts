import { test as base, expect } from "@playwright/test";
import { recordCoverage } from "./coverage";

export * from "@playwright/test";

// No app code waits on a view transition's `finished`, so a zero-length fade
// changes only how long waitForIdle sits on each render.
const INSTANT_FADES =
  "::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 0s !important; }";

/** Every spec imports `test` from here. `realFades` keeps the 250 ms view-transition fade for a spec that opts in. */
export const test = base.extend<{ realFades: boolean }>({
  realFades: [false, { option: true }],
  page: async ({ page, realFades, browserName }, use, info) => {
    if (!realFades) {
      await page.addInitScript((css) => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = css;
          document.head.append(style);
        });
      }, INSTANT_FADES);
    }
    // ui-guidelines R4: the page never opens alert/confirm/prompt, so any native dialog fails the test.
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      void d.dismiss();
    });
    // Set by `mise run frontend:test-e2e-coverage`; Chromium is the only browser exposing JS coverage.
    if (process.env.E2E_COVERAGE && browserName === "chromium") await recordCoverage(page, info, () => use(page));
    else await use(page);
    expect(dialogs, "native dialogs opened").toEqual([]);
  },
});
