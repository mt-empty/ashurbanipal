import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";
import { exerciseEveryRoute, expectScoped } from "./support/scope";

// Once start-up resolves the scope, every request names it rather than leaning
// on the server's defaults. The shared demo has one source, `primary`, whose
// default schema is `public`.

test("every scoped request after start-up names the source and the schema", async ({ page }) => {
  expectScoped(await exerciseEveryRoute(page), "primary", "public");
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
