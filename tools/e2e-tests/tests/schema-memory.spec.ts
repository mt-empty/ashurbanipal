import { test, expect, type Page } from "@playwright/test";
import { spawnDemo, freePort } from "./support/second-server";
import { waitForIdle } from "./support/helpers";

// ui-guidelines R12: the schema selected on a source is remembered, so
// switching source away and back restores it instead of resetting to
// `public`. Needs a multi-source demo (CONFORMANCE_SECOND_SOURCE adds an
// `other_schema` source); the shared seed already gives the `primary`
// source three schemas (public, other_schema, warehouse).

const APP = "/__ashurbanipal";

/** Picks an <option> and waits for the table-data refetch its onchange
 * kicks off to land, then for the view-transition to settle. `scopeParam`
 * (e.g. "schema=warehouse") pins the wait to *this* navigation's request,
 * not a stale in-flight one from the previous step. */
async function selectAndSettle(page: Page, selector: string, value: string, scopeParam: string) {
  const dataLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/tables/data") && r.url().includes(scopeParam) && r.ok(),
  );
  await page.locator(selector).selectOption(value);
  await dataLoaded;
  await waitForIdle(page);
}

test("schema is remembered per source across a source switch", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await page.goto(`${demo.baseUrl}${APP}`);
    await page.locator("#tables button.active").waitFor();
    await waitForIdle(page);

    // Both selectors render: two sources, and `primary` has three schemas.
    await expect(page.locator("#source-select-wrap")).toBeVisible();
    await expect(page.locator("#schema-select-wrap")).toBeVisible();
    await expect(page.locator("#schema-select")).toHaveValue("public");

    // Choose a non-default schema on `primary`, then bounce through the
    // other source and back.
    await selectAndSettle(page, "#schema-select", "warehouse", "schema=warehouse");
    await selectAndSettle(page, "#source-select", "other_schema", "source=other_schema");
    await selectAndSettle(page, "#source-select", "primary", "source=primary");

    // Restored, not reset to `public` (the pre-R12 behaviour).
    await expect(page.locator("#schema-select")).toHaveValue("warehouse");
    expect(await page.evaluate(() => {
      const raw = localStorage.getItem("ashurbanipal_ui");
      return raw ? JSON.parse(raw).schemaBySource : null;
    })).toMatchObject({ primary: "warehouse" });
  } finally {
    await demo.stop();
  }
});

test("a malformed schemaBySource is discarded, not fatal", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await page.goto(`${demo.baseUrl}${APP}`);
    await page.evaluate(() =>
      localStorage.setItem("ashurbanipal_ui", JSON.stringify({ schemaBySource: ["not", "an", "object"] })),
    );
    await page.reload();
    // Still boots and loads a table (R5).
    await page.locator("#tables button.active").waitFor();
    await waitForIdle(page);
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  } finally {
    await demo.stop();
  }
});
