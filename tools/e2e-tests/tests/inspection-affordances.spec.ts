import { expect, test } from "./support/fixtures";
import { applyFilter, dataWith, gotoApp, recordField, selectTable } from "./support/helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("payload dialog shows the raw JSON response and closes via its close button", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#payload").click();
  await expect(page.locator("#payload-dialog")).toBeVisible();
  const payloadText = await page.locator("#payload-pre").textContent();
  const parsed = JSON.parse(payloadText!);
  expect(Array.isArray(parsed.columns)).toBe(true);
  expect(Array.isArray(parsed.rows)).toBe(true);

  await page.locator('#payload-dialog button[aria-label="close"]').click();
  await expect(page.locator("#payload-dialog")).toBeHidden();
});

test("payload dialog also closes on Escape", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "products");
  await page.locator("#payload").click();
  await expect(page.locator("#payload-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#payload-dialog")).toBeHidden();
});

test("cell preview popover pretty-prints a large nested jsonb value and light-dismisses", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "payments");
  await applyFilter(page, "status = failed");
  const cell = page.locator("#tbody tr").first().locator('td[data-col="gateway_response"] .cell-text');
  await cell.click();

  await expect(page.locator("#cell-pop")).toBeVisible();
  await expect(page.locator("#cell-pre")).toBeHidden();
  const cellJson = page.locator("#cell-json");
  await expect(cellJson).toBeVisible();
  const keys = await cellJson.locator(".json-key").allTextContents();
  expect(keys).toContain('"gateway"');
  expect(keys).toContain('"risk"');

  await page.locator("#current").click();
  await expect(page.locator("#cell-pop")).toBeHidden();
});

test("per-cell copy button copies the cell's value to the clipboard", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstStatusCell = page.locator("#tbody tr").first().locator('td[data-col="status"]');
  const value = await firstStatusCell.locator(".cell-text").textContent();
  await firstStatusCell.hover();
  await firstStatusCell.locator(".copy").click();

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
});

test("record view lists every column as dt/dd, and per-field copy works", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator("#tbody tr").first();
  const statusValue = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();

  await expect(page.locator("#record-dialog")).toBeVisible();
  const columnNames = ["id", "user_id", "status", "total_cents", "discount_pct", "tags", "line_items", "created_at"];
  await expect(page.locator("#record-dl .record-name")).toHaveText(columnNames);

  const status = recordField(page, "status");
  await expect(status.dd).toHaveText(statusValue!);
  await status.copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(statusValue);
});

test("record view's whole-row copy button copies the full row as JSON", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator("#tbody tr").first();
  const statusValue = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  await page.locator("#record-copy-row").click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(clipboard);
  expect(parsed.status).toBe(statusValue);
  expect(Object.keys(parsed)).toEqual([
    "id",
    "user_id",
    "status",
    "total_cents",
    "discount_pct",
    "tags",
    "line_items",
    "created_at",
  ]);
});

test("whole-row JSON nests jsonb but keeps a Postgres array as its text, with no expand cue", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await applyFilter(page, "tags IS NOT NULL AND line_items IS NOT NULL");
  const firstRow = page.locator("#tbody tr").first();
  const tagsCell = firstRow.locator('td[data-col="tags"]');
  const tagsValue = await tagsCell.locator(".cell-text").textContent();
  expect(tagsValue).toMatch(/^\{.*\}$/);
  await expect(tagsCell).not.toHaveClass(/expandable/);
  await expect(firstRow.locator('td[data-col="line_items"]')).toHaveClass(/expandable/);

  await firstRow.locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  const tagsDd = recordField(page, "tags").dd;
  await expect(tagsDd).not.toHaveClass(/json-tree/);
  await expect(tagsDd).toHaveText(tagsValue!);

  await page.locator("#record-copy-row").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('"line_items": [');
  const parsed = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(parsed.tags).toBe(tagsValue);
  expect(Array.isArray(parsed.line_items)).toBe(true);
});

test("whole-row JSON keeps an integer above 2^53 inside jsonb exact", async ({ page }) => {
  // No seed value is that large, so the first orders row carries one.
  const big = '{"id": 9007199254740993, "ratio": 0.1000000000000000055511}';
  await page.route(dataWith("table", "orders"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.rows[0].line_items = big;
    await route.fulfill({ response, json: body });
  });
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  await page.locator("#record-copy-row").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"line_items": {\n    "id": 9007199254740993,\n    "ratio": 0.1000000000000000055511\n  }');
});

test("record view's INSERT copy button copies the row as a SQL INSERT", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstRow = page.locator("#tbody tr").first();
  const id = await firstRow.locator('td[data-col="id"] .cell-text').textContent();
  const status = await firstRow.locator('td[data-col="status"] .cell-text').textContent();
  const totalCents = await firstRow.locator('td[data-col="total_cents"] .cell-text').textContent();
  const discountPct = await firstRow.locator('td[data-col="discount_pct"] .cell-text').textContent();
  await firstRow.locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();

  await page.locator("#record-copy-insert").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("INSERT INTO ");
  const sql = await page.evaluate(() => navigator.clipboard.readText());

  // The e2e demo has multiple schemas, so the table name is schema-qualified.
  expect(sql).toMatch(
    /^INSERT INTO (public\.)?orders \(id, user_id, status, total_cents, discount_pct, tags, line_items, created_at\)\nVALUES \(/,
  );
  expect(sql).toContain(`'${id}'`);
  expect(sql).toContain(`'${status}'`);
  expect(sql).toContain(`, ${totalCents}, `);
  expect(sql).not.toContain(`'${totalCents}'`);
  if (discountPct === "∅") expect(sql).toContain(", NULL, ");
  expect(sql.endsWith(");")).toBe(true);
});

test("record view closes via Escape", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#record-dialog")).toBeHidden();
});

test("record view shows each field's key icon, type and comment", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  await expect(recordField(page, "id").key).toHaveText("🔑");
  await expect(recordField(page, "user_id").key).toHaveText("🔗");
  await expect(recordField(page, "status").key).toHaveText("");
  await expect(recordField(page, "id").dt.locator("code.col-type")).toHaveText("uuid");
  await expect(recordField(page, "user_id").dd.locator(".record-note")).toHaveText(
    "The user who placed this order. · references users.id",
  );
  await expect(recordField(page, "status").dd.locator(".record-note")).toHaveCount(0);
});

test("a foreign key value in the record view closes the dialog and opens the referenced row", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const userId = await page.locator("#tbody tr").first().locator('td[data-col="user_id"] .cell-text').textContent();
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await recordField(page, "user_id").dd.locator(".record-link").click();
  await expect(page.locator("#record-dialog")).toBeHidden();
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue(`id = ${userId}`);
});

test("a composite foreign key value in the record view filters on every pair", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "inventory_counts");
  const row = page.locator("#tbody tr").first();
  const warehouse = await row.locator('td[data-col="warehouse_code"] .cell-text').textContent();
  const bin = await row.locator('td[data-col="bin_code"] .cell-text').textContent();
  await row.locator(".record-btn").click();
  await recordField(page, "bin_code").dd.locator(".record-link").click();
  await page.locator("#current").getByText("inventory_locations", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue(`warehouse_code = ${warehouse} AND bin_code = ${bin}`);
});

test("= in the record view closes the dialog and filters on that value", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const status = await page.locator("#tbody tr").first().locator('td[data-col="status"] .cell-text').textContent();
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await recordField(page, "status").eq.click();
  await expect(page.locator("#record-dialog")).toBeHidden();
  await expect(page.locator("#filter")).toHaveValue(`status = ${status}`);
});

test("previous and next step through the page's rows and stop at its ends", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const rows = page.locator("#tbody tr");
  const count = await rows.count();
  const idOf = (i: number) => rows.nth(i).locator('td[data-col="id"] .cell-text').textContent();
  await rows.first().locator(".record-btn").click();
  await expect(page.locator("#record-pos")).toHaveText(`1 of ${count}`);
  await expect(page.locator("#record-prev")).toBeDisabled();

  await page.locator("#record-next").click();
  await expect(page.locator("#record-pos")).toHaveText(`2 of ${count}`);
  await expect(recordField(page, "id").dd).toHaveText((await idOf(1))!);
  await page.locator("#record-prev").click();
  await expect(recordField(page, "id").dd).toHaveText((await idOf(0))!);
  await page.keyboard.press("Escape");

  await rows.last().locator(".record-btn").click();
  // Opening moves focus into the dialog, so wait for it before focusing a button.
  await expect(page.locator("#record-dialog")).toBeVisible();
  await expect(page.locator("#record-pos")).toHaveText(`${count} of ${count}`);
  await expect(page.locator("#record-next")).toBeDisabled();
  await expect(page.locator("#record-prev")).toBeEnabled();

  // Reaching an end from the keyboard leaves focus on the other button, not lost.
  await page.locator("#record-prev").focus();
  await page.keyboard.press("Enter");
  await page.locator("#record-next").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#record-next")).toBeDisabled();
  await expect(page.locator("#record-prev")).toBeFocused();
});

test("copying a value with marked edge whitespace copies the raw value", async ({ page }) => {
  // No seed value has edge whitespace, so the first products row carries some.
  const raw = "  Team mug, 350 ml\n";
  await page.route(dataWith("table", "products"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.rows[0].description = raw;
    await route.fulfill({ response, json: body });
  });
  await gotoApp(page);
  await selectTable(page, "products");
  const cell = page.locator("#tbody tr").first().locator('td[data-col="description"]');
  await expect(cell.locator(".cell-ws")).toHaveCount(2);
  await cell.hover();
  await cell.locator(".copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
});
