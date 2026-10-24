import { existsSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";
import { gotoJoin, ORDERS_USERS } from "./support/join";

// Playwright's WebKit occasionally stops answering mid-test under load, about one run
// in a hundred. A short cap fails such a run fast and a retry absorbs it; a real
// regression still fails every attempt.
test.describe.configure({ timeout: 20_000, retries: 2 });

// Debian/Ubuntu paths of fonts-freefont-ttf and fonts-ipafont-gothic, which
// `playwright install --with-deps` adds on Linux.
const TALL_FONT = "/usr/share/fonts/truetype/freefont/FreeSerif.ttf";
const BASE_FONT = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf";
test.skip(![TALL_FONT, BASE_FONT].every(existsSync), "needs the FreeSerif and IPAGothic system fonts");

// Symbol glyphs (⟕, ⧉) that a system font lacks are drawn from a fallback font,
// whose taller metrics must not resize the row they sit in. IPAGothic lacks them
// but has ✓, so it plays the system font; both it and FreeSerif ship with
// Playwright's deps. WebKit ignores unicode-range and the metric overrides on
// local() faces, so the tall fallback is served as a file.
async function tallFallback(page: Page, glyphs: string, selector: string) {
  await page.route("**/glyph-probe.ttf", (route) => route.fulfill({ path: TALL_FONT, contentType: "font/ttf" }));
  const range = [...glyphs].map((g) => `U+${g.codePointAt(0)!.toString(16).toUpperCase()}`).join(", ");
  const css = `
    @font-face { font-family: GlyphProbeTall; src: url(glyph-probe.ttf); unicode-range: ${range};
                 ascent-override: 150%; descent-override: 50%; }
    ${selector} { font-family: IPAGothic, GlyphProbeTall !important; }`;
  return async (extraCss = "") => {
    await page.addStyleTag({ content: css + extraCss });
    await page.evaluate((g) => document.fonts.load("14px GlyphProbeTall", g), glyphs);
  };
}

test("join-only glyphs drawn from a taller fallback font leave the title row as a table's", async ({ page }) => {
  const probe = await tallFallback(page, "⟕⧉", "#current, #actions button");
  const titleRow = async (extraCss = "") => {
    await probe(extraCss);
    return page.evaluate(() => {
      const top = (id: string) => document.getElementById(id)!.getBoundingClientRect().top;
      const meta = document.getElementById("meta")!.getBoundingClientRect();
      return { height: meta.height, title: top("current") - meta.top, refresh: top("refresh") - meta.top };
    });
  };

  await gotoApp(page, "?table=orders");
  const table = await titleRow();
  await gotoJoin(page, ORDERS_USERS);
  await expect(page.locator("#current")).toContainText("⟕");
  expect(await titleRow()).toEqual(table);
  // The probe is tall enough to move the row under the default line height.
  expect((await titleRow("#meta { line-height: normal !important; }")).height).toBeGreaterThan(table.height);
});

test("a record copy button keeps its size while ⧉ flashes to a tick", async ({ page }) => {
  // Only the tick matters here, so the clipboard write always succeeds.
  await page.addInitScript(() => {
    Clipboard.prototype.writeText = () => Promise.resolve();
  });
  await gotoApp(page);
  await selectTable(page, "orders");
  const probe = await tallFallback(page, "⧉", "#record-dialog .copy");
  await probe();
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  const layout = (btn: Locator) =>
    btn.evaluate((b) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const dts = [...document.querySelectorAll("#record-dl dt")];
      const next = dts[dts.findIndex((dt) => dt.textContent === "status") + 1];
      return {
        button: box(b).height,
        head: box(document.querySelector("#record-dialog .dialog-head")!).height,
        nextField: box(next).top - box(document.getElementById("record-dl")!).top,
      };
    });
  const flash = async (btn: Locator) => {
    const before = await layout(btn);
    await btn.click();
    await expect(btn.locator(".copy-icon")).toHaveText("✓");
    const during = await layout(btn);
    await expect(btn.locator(".copy-icon")).toHaveText("⧉");
    return { before, during };
  };

  const statusCopy = page.locator("#record-dl dt", { hasText: /^status$/ }).locator("xpath=following-sibling::button[1]");
  for (const btn of [page.locator("#record-copy-row"), statusCopy]) {
    const { before, during } = await flash(btn);
    expect(during).toEqual(before);
  }
  // The probe is tall enough to resize the button under the default line height.
  await probe(".copy-icon { line-height: normal !important; }");
  const { before, during } = await flash(statusCopy);
  expect(during.button).not.toEqual(before.button);
});
