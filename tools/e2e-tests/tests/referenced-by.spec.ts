import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, uiState, waitForIdle } from "./support/helpers";

// Seed shape (conformance/seed): public.users is referenced by orders.user_id
// and support_tickets.(user_id, assigned_admin_id); public.inventory_locations
// by the composite FK inventory_counts.(warehouse_code, bin_code).

test("PK-cell popover lists incoming FKs and drills into a referrer filtered to the row", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");

  const idCell = page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text.pk-cell');
  const userId = await idCell.textContent();
  await idCell.click();

  const pop = page.locator("#refby-pop");
  await expect(pop).toBeVisible();
  await expect(pop.getByRole("button", { name: /^→ orders \(user_id\)/ })).toBeVisible();
  await expect(pop.getByRole("button", { name: /support_tickets/ })).toHaveCount(2);

  await pop.getByRole("button", { name: /^→ orders \(user_id\)/ }).click();

  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(pop).toBeHidden();
  await expect(page.locator("#filter")).toHaveValue(`user_id = ${userId}`);
  // The filter rides the URL (shareable view) but never localStorage (R6).
  await expect(page).toHaveURL(/[?&]filter=/);
  expect(await uiState(page)).not.toHaveProperty("filter");

  const userIdCells = page.locator('#tbody td[data-col="user_id"] .cell-text');
  await expect
    .poll(async () => {
      const values = await userIdCells.allTextContents();
      return values.length > 0 && values.every((v) => v === userId);
    })
    .toBe(true);
});

test("the record dialog's 'referenced by' section drills in and closes the dialog", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");

  const firstRow = page.locator("#tbody tr").first();
  const userId = await firstRow.locator('td[data-col="id"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();

  const dialog = page.locator("#record-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#record-referenced-by").getByRole("button", { name: /^→ orders \(user_id\)/ }).click();

  await expect(dialog).toBeHidden();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator("#filter")).toHaveValue(`user_id = ${userId}`);
});

test("a composite-key referrer drills in with an AND filter over both columns", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "inventory_locations");

  const firstRow = page.locator("#tbody tr").first();
  const warehouse = await firstRow.locator('td[data-col="warehouse_code"] .cell-text').textContent();
  const bin = await firstRow.locator('td[data-col="bin_code"] .cell-text').textContent();
  await firstRow.locator('td[data-col="warehouse_code"] .cell-text.pk-cell').click();

  const pop = page.locator("#refby-pop");
  await expect(pop).toBeVisible();
  await pop.getByRole("button", { name: /^→ inventory_counts \(warehouse_code, bin_code\)/ }).click();

  await page.locator("#current").getByText("inventory_counts", { exact: true }).waitFor();
  await waitForIdle(page);
  await expect(page.locator("#filter")).toHaveValue(/^warehouse_code = .+ AND bin_code = .+$/);

  const rows = page.locator("#tbody tr");
  await expect
    .poll(async () => {
      const w = await rows.locator('td[data-col="warehouse_code"] .cell-text').allTextContents();
      const b = await rows.locator('td[data-col="bin_code"] .cell-text').allTextContents();
      return w.length > 0 && w.every((v) => v === warehouse) && b.every((v) => v === bin);
    })
    .toBe(true);
});

test("a table nothing references shows an empty 'referenced by' list", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "feature_flags");

  const firstRow = page.locator("#tbody tr").first();
  await firstRow.locator(".record-btn").click();

  const section = page.locator("#record-dialog #record-referenced-by");
  await expect(section.getByText("nothing references this table")).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
});

test("a cross-schema referrer absent from the target schema's own table list surfaces an error, not a mismatched filter", async ({
  page,
}) => {
  // Regression test: navigateWithSeededFilter's cross-schema branch sets
  // state.table to the drill-in target before loadTables() resolves;
  // loadTables()'s stale-state fallback (meant for stale localStorage)
  // silently resets state.table and, until fixed, still applies the seeded
  // filter — to whatever table it fell back to, not the one clicked. This
  // is reachable whenever a referenced_by entry names a table the target
  // schema's /api/tables doesn't list (e.g. a partitioned referrer);
  // mocked here rather than requiring a live partitioned-table fixture.
  await gotoApp(page);
  await selectTable(page, "users");

  await page.route("**/api/tables/referenced-by*", (route) =>
    route.fulfill({
      json: {
        referenced_by: [
          { schema: "warehouse", table: "ghost_events", constraint: "fk_ghost", columns: [{ from: "user_id", to: "id" }] },
        ],
      },
    }),
  );
  await page.route("**/api/tables*", (route) => {
    const schema = new URL(route.request().url()).searchParams.get("schema");
    if (schema === "warehouse") return route.fulfill({ json: { tables: [{ name: "shipment_events" }] } });
    return route.continue();
  });

  const idCell = page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text.pk-cell');
  await idCell.click();
  const pop = page.locator("#refby-pop");
  await expect(pop).toBeVisible();
  await pop.getByRole("button", { name: /ghost_events/ }).click();

  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#filter")).toHaveValue("");
});

test("an entry naming a column absent from the row (the referenced table has no primary key) is disabled with an accurate message", async ({
  page,
}) => {
  // finding #7, option 1: SQLite's rowid fallback (spec/protocol.md §5.9)
  // means `to` can name a column /api/tables/data never exposes — that must
  // read as "no primary key to filter by", not "column is null" (row["rowid"]
  // is genuinely undefined here, not a real column holding a null value).
  await gotoApp(page);
  await selectTable(page, "users");

  await page.route("**/api/tables/referenced-by*", (route) =>
    route.fulfill({
      json: {
        referenced_by: [
          { table: "ghost_children", constraint: "fk_ghost", columns: [{ from: "parent_ref", to: "rowid" }] },
        ],
      },
    }),
  );

  const idCell = page.locator("#tbody tr").first().locator('td[data-col="id"] .cell-text.pk-cell');
  await idCell.click();
  const pop = page.locator("#refby-pop");
  await expect(pop).toBeVisible();
  const btn = pop.getByRole("button", { name: /ghost_children/ });
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute("title", "this table has no primary key — no filter is expressible");
});
