import { test as base } from "@playwright/test";

export * from "@playwright/test";

// No app code waits on a view transition's `finished`, so a zero-length fade
// changes only how long waitForIdle sits on each render.
const INSTANT_FADES =
  "::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 0s !important; }";

/** Every spec imports `test` from here. `realFades` keeps the 250 ms view-transition fade for a spec that opts in. */
export const test = base.extend<{ realFades: boolean }>({
  realFades: [false, { option: true }],
  page: async ({ page, realFades }, use) => {
    if (!realFades) {
      await page.addInitScript((css) => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = css;
          document.head.append(style);
        });
      }, INSTANT_FADES);
    }
    await use(page);
  },
});
