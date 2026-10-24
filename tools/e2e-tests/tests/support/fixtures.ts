import { test as base, expect } from "@playwright/test";
import { recordCoverage } from "./coverage";

export * from "@playwright/test";

// Why fades are zero-length: docs/e2e-testing-guidelines.md §2.
const INSTANT_FADES =
  "::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 0s !important; }";

/** Every spec imports `test` from here. `realFades` keeps the 250 ms view-transition fade for a spec that opts in.
 * Fades and the dialog guard are set on the context, so a second page a test opens gets them too. */
export const test = base.extend<{ realFades: boolean }>({
  realFades: [false, { option: true }],
  context: async ({ context, realFades }, use) => {
    if (!realFades) {
      await context.addInitScript((css) => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = css;
          document.head.append(style);
        });
      }, INSTANT_FADES);
    }
    // ui-guidelines R4: the page never opens alert/confirm/prompt, so any native dialog fails the test.
    const dialogs: string[] = [];
    context.on("dialog", (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      void d.dismiss();
    });
    await use(context);
    expect(dialogs, "native dialogs opened").toEqual([]);
  },
  page: async ({ page, browserName }, use, info) => {
    // Set by `mise run frontend:test-e2e-coverage`; Chromium is the only browser exposing JS coverage.
    if (process.env.E2E_COVERAGE && browserName === "chromium") await recordCoverage(page, info, () => use(page));
    else await use(page);
  },
});
