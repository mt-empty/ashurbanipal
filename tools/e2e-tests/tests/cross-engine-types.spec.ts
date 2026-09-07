import { expect, test } from "@playwright/test";
import { gotoApp, selectTable } from "./support/helpers";

// The suite serves the shared frontend against Postgres, but the same
// artifact must render MySQL/SQLite catalog type spellings too. Mock
// /tables/data with a column set using non-Postgres spellings plus two
// opaque ("unknown") columns, then assert the type-aware affordances still
// fire. `users` is just a table the sidebar lists; the mock replaces its
// payload wholesale.

const payload = {
  columns: [
    { name: "n", type: "int" }, // MySQL
    { name: "amount", type: "DECIMAL(10,2)" }, // SQLite-style, with precision suffix
    { name: "ts", type: "datetime" }, // MySQL
    { name: "flag", type: "BOOLEAN" }, // SQLite-style
    { name: "doc", type: "json" }, // MySQL
    { name: "opaque_doc", type: "unknown" }, // SQLite dynamic-typed, brace-leading value
    { name: "opaque_scalar", type: "unknown" }, // SQLite dynamic-typed, bare scalar
    { name: "opaque_id", type: "unknown" }, // SQLite dynamic-typed, UUID-shaped value
    { name: "label", type: "VARCHAR(20)" },
  ],
  rows: [
    {
      n: "42",
      amount: "19.99",
      ts: "2016-01-01 12:00:00",
      flag: "1",
      doc: '{"a":1,"b":[2,3]}',
      opaque_doc: '{"nested":true}',
      opaque_scalar: "42",
      opaque_id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      label: "hello",
    },
  ],
  total_approx: 1,
};

test("MySQL/SQLite type spellings still drive type-aware rendering", async ({ page }) => {
  await gotoApp(page);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: payload }));
  await selectTable(page, "users");

  // Header renders the engine-native type spelling as inline <code>.
  await expect(page.locator('th[data-col="n"] code.col-type')).toHaveText("int");
  await expect(page.locator('th[data-col="label"] code.col-type')).toHaveText("VARCHAR(20)");

  // number / bool / date spellings resolve to the same classes as Postgres.
  await expect(page.locator('td[data-col="n"] .cell-type-number')).toBeVisible();
  await expect(page.locator('td[data-col="amount"] .cell-type-number')).toBeVisible();
  await expect(page.locator('td[data-col="flag"] .cell-type-bool')).toBeVisible();
  await expect(page.locator('td[data-col="ts"] time.cell-type-date')).toBeVisible();
  // Opaque type + UUID-shaped value still gets the uuid colour (value-shape fallback).
  await expect(page.locator('td[data-col="opaque_id"] .cell-type-uuid')).toBeVisible();
  // The <time> element carries no (invalid on every engine) datetime attribute.
  expect(await page.locator('td[data-col="ts"] time').getAttribute("datetime")).toBeNull();

  // MySQL `json` and a brace-leading value in an opaque column are both
  // marked expandable at render; a bare scalar in an opaque column is not.
  await expect(page.locator('td[data-col="doc"]')).toHaveClass(/expandable/);
  await expect(page.locator('td[data-col="opaque_doc"]')).toHaveClass(/expandable/);
  await expect(page.locator('td[data-col="opaque_scalar"]')).not.toHaveClass(/expandable/);
});
