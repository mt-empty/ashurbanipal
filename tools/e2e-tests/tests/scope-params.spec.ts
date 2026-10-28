import { expect, test } from "./support/fixtures";
import { APP_PATH, gotoApp, selectTable, waitForIdle } from "./support/helpers";
import { gotoJoin, ORDERS_USERS } from "./support/join";

// Once start-up resolves the scope, every request names it rather than leaning
// on the server's defaults. The shared demo has one source, `primary`, whose
// default schema is `public`.

// Routes that take no scope, or only a source; every other API request must name both.
const UNSCOPED = new Set(["/sources", "/siblings"]);
const SOURCE_ONLY = new Set(["/schemas"]);

test("every scoped request names the source and the schema", async ({ page }) => {
  const seen: URL[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith(`${APP_PATH}/api/`)) seen.push(url);
  });

  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('th[data-col="status"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  await page.locator('.common-values-btn[aria-label="common values for status"]').click();
  await expect(page.locator("#cv-pop-list button.cv-value").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#structure-btn").click();
  await expect(page.locator("#structure-body").getByText("orders_pending_idx")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-referenced-by")).not.toContainText("loading…");
  await page.keyboard.press("Escape");
  await gotoJoin(page, ORDERS_USERS);

  const routes = new Set(seen.map((u) => u.pathname.slice(`${APP_PATH}/api`.length)));
  for (const route of [
    "/tables",
    "/table-counts",
    "/tables/data",
    "/tables/common-values",
    "/tables/structure",
    "/tables/referenced-by",
    "/tables/join",
  ]) {
    expect(routes, `no ${route} request was made`).toContain(route);
  }
  for (const url of seen) {
    const route = url.pathname.slice(`${APP_PATH}/api`.length);
    const scope = { source: url.searchParams.get("source"), schema: url.searchParams.get("schema") };
    if (UNSCOPED.has(route)) expect(scope, route).toEqual({ source: null, schema: null });
    else if (SOURCE_ONLY.has(route)) expect(scope, route).toEqual({ source: "primary", schema: null });
    else expect(scope, `${route}${url.search}`).toEqual({ source: "primary", schema: "public" });
  }
});

test("the page URL names the source and schema only where there was a choice", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const params = new URL(page.url()).searchParams;
  expect(params.get("source")).toBeNull();
  // One source, but three schemas.
  expect(params.get("schema")).toBe("public");
});

test("stored data under the retired keys is removed, and start-up still works", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "ashurbanipal_ui",
      JSON.stringify({ table: "orders", sortByTable: { '[null,null,"orders"]': { col: "ghost_col", order: "asc" } } }),
    );
    localStorage.setItem("ashurbanipal_joins", JSON.stringify({ "": { "": [{ name: "old", text: "FROM a" }] } }));
  });
  await gotoApp(page);
  await expect(page.locator("#tbody tr").first()).toBeVisible();
  const stored = await page.evaluate(() => [
    localStorage.getItem("ashurbanipal_ui"),
    localStorage.getItem("ashurbanipal_joins"),
  ]);
  expect(stored).toEqual([null, null]);
});
