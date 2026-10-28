import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable } from "./support/helpers";
import { exerciseEveryRoute, expectScoped } from "./support/scope";

// What the UI opens on an engine other than the shared demo's Postgres. playwright.config.ts runs it only when
// E2E_BACKEND names such an engine, and then runs nothing else.
const BACKEND = process.env.E2E_BACKEND ?? "";

// The server's connection default: SQLite's one `main` schema; MySQL's `database()`, which the seed names ashurbanipal.
const DEFAULT_SCHEMA: Record<string, string> = { sqlite: "main", mysql: "ashurbanipal" };

test("every scoped request names the source and the engine's default schema", async ({ page }) => {
  expectScoped(await exerciseEveryRoute(page), "primary", DEFAULT_SCHEMA[BACKEND]);
});

test("the schema picker and page URL follow how many schemas the engine has", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const params = new URL(page.url()).searchParams;
  expect(params.get("source")).toBeNull();
  if (BACKEND === "sqlite") {
    await expect(page.locator("#schema-select-wrap")).toBeHidden();
    expect(params.get("schema")).toBeNull();
  } else {
    await expect(page.locator("#schema-select")).toHaveValue(DEFAULT_SCHEMA[BACKEND]);
    expect(params.get("schema")).toBe(DEFAULT_SCHEMA[BACKEND]);
  }
});
