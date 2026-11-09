import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { apiCall, gotoApp, urlParam, waitForTable } from "./support/helpers";
import { expandTableChips, joinParam, pick, showResult, storedSavedJoins, writeSql } from "./support/join";

// A join across two schemas of one source (backlog story 44; boards BE and BG).
// Seed: warehouse.shipments.order_id → public.orders.id, and warehouse.users
// beside public.users.

const SHIPMENTS = "?schema=warehouse&table=shipments";
const CROSS = "FROM shipments s LEFT JOIN public.orders o ON s.order_id = o.id";

const crossView = (page: Page, text: string) => gotoApp(page, `${SHIPMENTS}&limit=5&join=${encodeURIComponent(text)}`);

async function openFromShipments(page: Page) {
  await gotoApp(page, SHIPMENTS);
  await page.locator("#join-btn").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
}

test("the form joins a table from another schema and suggests the foreign key pair into it", async ({ page }) => {
  await openFromShipments(page);
  await expect(page.getByRole("button", { name: "start schema", exact: true })).toHaveText("warehouse ▾");
  const listed = page.waitForResponse(apiCall("/tables", { schema: "public" }));
  await pick(page, "join 1 schema", "public");
  await listed;
  await pick(page, "join 1 table", "orders");
  await expect(page.locator(".j-row").first()).toContainText(
    "Suggested from the foreign key shipments.order_id → orders.id.",
  );
  await expect(page.locator("#join-preview")).toHaveText(
    "SELECT *\nFROM shipments\nINNER JOIN public.orders ON shipments.order_id = orders.id",
  );

  const response = await showResult(page);
  expect(new URL(response.url()).searchParams.get("schema")).toBe("warehouse");
  expect(joinParam(response.url())).toEqual({
    table: "shipments",
    joins: [
      {
        type: "inner",
        table: "orders",
        schema: "public",
        on: [{ left: { join: 0, column: "order_id" }, right: "id" }],
      },
    ],
  });
  // Board BG, widened: in a join that spans schemas every band names its schema.
  await expect(page.locator("th.band")).toHaveText(["warehouse.shipments", "public.orders"]);
  await expect(page.locator("#current")).toHaveText("warehouse.shipments ⋈ public.orders");
});

test("a join within one schema keeps its labels bare", async ({ page }) => {
  await crossView(page, "FROM shipments s JOIN carriers c ON s.carrier_id = c.id");
  await expect(page.locator("th.band")).toHaveText(["shipments s", "carriers c"]);
});

test("the form has no schema dropdown when the source lists one schema", async ({ page }) => {
  await page.route(apiCall("/schemas"), (route) =>
    route.fulfill({ json: { schemas: [{ name: "public" }], default: "public" } }),
  );
  await gotoApp(page, "?table=orders");
  await page.locator("#join-btn").click();
  await expect(page.getByRole("button", { name: "start table", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "start schema", exact: true })).toHaveCount(0);
});

test("SQL mode offers the other schemas after JOIN, then that schema's tables with the foreign key first", async ({
  page,
}) => {
  await openFromShipments(page);
  await writeSql(page, "FROM shipments s LEFT JOIN ");
  const sql = page.locator("#join-sql");
  const options = page.locator("#join-sql-suggest button");
  await sql.press("End");
  await sql.pressSequentially("pu");
  await expect(options.first()).toContainText("public.");
  await expect(options.first()).toContainText("schema");
  await sql.press("Tab");
  await expect(sql).toHaveValue("FROM shipments s LEFT JOIN public.");
  await expect(options.first()).toContainText("orders o ON s.order_id = o.id");
  await expect(options.first()).toContainText("foreign key");
  await sql.press("Tab");
  await expect(sql).toHaveValue(`${CROSS} `);
});

test("SQL mode checks a qualified name against that schema's tables", async ({ page }) => {
  await openFromShipments(page);
  await writeSql(page, "FROM shipments s JOIN public.orders o ON s.order_id = o.id");
  // public's tables are read once it is named; the typo is caught against them.
  await page.locator("#join-sql").fill("FROM shipments s JOIN public.ordrs o ON s.order_id = o.id");
  await expect(page.locator("#join-sql-error")).toContainText(
    "There is no table ordrs in public. Did you mean orders?",
  );
  await page.locator("#join-sql").fill("FROM shipments s JOIN nosuch.orders o ON s.order_id = o.id");
  await expect(page.locator("#join-sql-error")).toContainText("There is no schema nosuch.");
});

test("two same-named tables from two schemas need an alias, and the message names both", async ({ page }) => {
  await openFromShipments(page);
  await writeSql(page, "FROM users JOIN public.users ON users.id = users.id");
  await expect(page.locator("#join-sql-error")).toContainText("users and public.users");
});

test("a foreign key link on a column from another schema opens the table in that column's schema", async ({ page }) => {
  // spec/protocol.md §5.11.4: o.user_id references users with no schema, which is public.users.
  await crossView(page, "SELECT s.id, o.user_id FROM shipments s LEFT JOIN public.orders o ON s.order_id = o.id");
  await expect(page.locator("th.band")).toHaveText(["warehouse.shipments s", "public.orders o"]);
  await page.locator("#tbody tr").first().locator(".fk-cell").click();
  await waitForTable(page, "users");
  expect(urlParam(page, "schema")).toBe("public");
  await expect(page.locator("#schema-select")).toHaveValue("public");
  expect(urlParam(page, "filter")).toMatch(/^id = /);
});

test("common values of a column from another schema come from that schema's table", async ({ page }) => {
  await crossView(page, "SELECT s.id, o.status FROM shipments s LEFT JOIN public.orders o ON s.order_id = o.id");
  const asked = page.waitForRequest(apiCall("/tables/common-values", { table: "orders", schema: "public" }));
  await page.locator('.common-values-btn[aria-label="common values for o.status"]').click();
  await asked;
  await expect(page.locator("#cv-pop-list .cv-note")).toHaveText(
    "Shares of all rows in public.orders, not indicative of this join",
  );
});

test("a join saved with its own schema written out is stored and shown without it", async ({ page }) => {
  await openFromShipments(page);
  await writeSql(page, "FROM warehouse.shipments s LEFT JOIN public.orders o ON s.order_id = o.id");
  await page.locator("#join-name").fill("shipments with orders");
  await showResult(page);
  const stored = JSON.parse((await storedSavedJoins(page)) as string);
  expect(Object.values(stored).flat()).toEqual([
    {
      name: "shipments with orders",
      text: "SELECT *\nFROM shipments s\nLEFT JOIN public.orders o ON s.order_id = o.id",
    },
  ]);
  await expandTableChips(page);
  const chip = page.locator("#tables li.join-chip :is(a, button)", { hasText: "shipments with orders" });
  await expect(chip).toHaveAttribute("aria-current", "true");
});
