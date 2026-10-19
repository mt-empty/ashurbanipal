import { expect, test } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";
import {
  expandTableChips,
  gotoJoin,
  joinParam,
  nextJoinResponse,
  openJoinOverlay,
  ORDERS_USERS,
  pick,
  showResult,
  writeSql,
} from "./support/join";

// Story 41: the join overlay (boards O, U, V), in its Form and SQL modes.
// Backend: the seed's orders -> users (FK) and order_extra -> orders (FK, 1:1).

const ORDERS_USERS_EXTRA = {
  table: "orders",
  joins: [
    { type: "left", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] },
    { type: "left", table: "order_extra", on: [{ left: { join: 0, column: "id" }, right: "order_id" }] },
  ],
};

test("the form suggests the foreign key pair and builds a three-table join", async ({ page }) => {
  await openJoinOverlay(page);
  await pick(page, "join 1 type", "left");
  await pick(page, "join 1 table", "users");
  await expect(page.locator(".j-row").first()).toContainText("Suggested from the foreign key orders.user_id → users.id.");
  await page.getByRole("button", { name: "add a table to the join" }).click();
  await pick(page, "join 2 type", "left");
  await pick(page, "join 2 table", "order_extra");
  await expect(page.locator(".j-row").nth(1)).toContainText("Suggested from the foreign key orders.id → order_extra.order_id.");
  await expect(page.locator("#join-preview")).toHaveText(
    "SELECT *\nFROM orders\nLEFT JOIN users ON orders.user_id = users.id\nLEFT JOIN order_extra ON orders.id = order_extra.order_id",
  );

  const response = await showResult(page);
  expect(joinParam(response.url())).toEqual(ORDERS_USERS_EXTRA);
  await expect(page.locator("#join-dialog")).toBeHidden();
  await expect(page.locator("th.band")).toHaveText(["orders", "users", "order_extra"]);
  await expect(page.locator("#current")).toHaveText("orders ⟕ users ⟕ order_extra");
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("the form shows the table limit and lets a join be removed", async ({ page }) => {
  await openJoinOverlay(page);
  await pick(page, "join 1 table", "users");
  await page.getByRole("button", { name: "add a table to the join" }).click();
  await pick(page, "join 2 table", "order_extra");
  await page.getByRole("button", { name: "add a table to the join" }).click();
  await pick(page, "join 3 table", "payments");
  const add = page.getByRole("button", { name: "add a table to the join" });
  await expect(add).toBeDisabled();
  await expect(page.locator(".j-add")).toContainText("Joins are limited to 4 tables. Remove one to add another.");
  await page.getByRole("button", { name: "remove join 1" }).click();
  await expect(add).toBeEnabled();
  await expect(page.locator(".j-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "join 1 table" })).toHaveText("order_extra ▾");
});

test("the column cards pick what the result shows", async ({ page }) => {
  await openJoinOverlay(page);
  await pick(page, "join 1 table", "users");
  await page.getByRole("checkbox", { name: "orders.id", exact: true }).uncheck();
  await expect(page.locator(".j-card").first().locator("h3")).toContainText("7 of 8");
  await expect(page.locator("#join-preview")).toContainText("SELECT orders.user_id, ");
  const response = await showResult(page);
  const columns = (joinParam(response.url()) as { columns: { join: number; column: string }[] }).columns;
  expect(columns).toHaveLength(7 + 9);
  expect(columns).not.toContainEqual({ join: 0, column: "id" });
});

test("the SQL text builds the same join and switching modes keeps the definition", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "from orders left join users on users.id = orders.user_id\nleft join order_extra on order_extra.order_id = orders.id");
  await page.locator("#join-mode-form").click();
  await expect(page.getByRole("button", { name: "join 2 table" })).toHaveText("order_extra ▾");
  await expect(page.locator("#join-preview")).toContainText("LEFT JOIN users ON orders.user_id = users.id");
  await page.locator("#join-mode-sql").click();
  await expect(page.locator("#join-sql")).toHaveValue(/^SELECT \*\nFROM orders\nLEFT JOIN users ON orders\.user_id = users\.id\nLEFT JOIN order_extra/);

  const response = await showResult(page);
  expect(joinParam(response.url())).toEqual(ORDERS_USERS_EXTRA);
});

test("text that does not parse disables Form and Show result and says where and why", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o\nRIGHT JOIN users u ON o.user_id = u.id");
  await expect(page.locator("#join-mode-form")).toBeDisabled();
  await expect(page.locator("#join-run")).toBeDisabled();
  await expect(page.locator("#join-sql-error")).toHaveText("Line 2: RIGHT joins are not supported. Swap the two tables and use LEFT.");
  await expect(page.locator("#join-sql-tip")).toBeVisible();
  await expect(page.locator("#join-sql-hl-text .t-err")).toHaveText(["RIGHT", "JOIN"]);

  await page.locator("#join-sql").fill(ORDERS_USERS);
  await expect(page.locator("#join-mode-form")).toBeEnabled();
  await expect(page.locator("#join-run")).toBeEnabled();
  await expect(page.locator("#join-sql-error")).toBeEmpty();
});

test("each part the join text may not contain gets its own message", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, `${ORDERS_USERS}\nWHERE u.age > 30`);
  await expect(page.locator("#join-sql-error")).toHaveText("Line 2: WHERE is not part of the join. Filter with the bar above the grid.");
  await page.locator("#join-sql").fill("FROM orders o JOIN users u ON u.id = o.usr_id");
  await expect(page.locator("#join-sql-error")).toHaveText("Line 1: orders has no column usr_id. Did you mean user_id?");
});

test("an incompatible pair is refused in the text before any request", async ({ page }) => {
  await openJoinOverlay(page);
  let requests = 0;
  await page.route("**/api/tables/join*", (route) => {
    requests++;
    return route.continue();
  });
  await writeSql(page, "FROM orders o LEFT JOIN users u ON u.id = o.status");
  await expect(page.locator("#join-sql-error")).toHaveText("Line 1: uuid cannot be joined to enum. Pick columns of the same kind.");
  await expect(page.locator("#join-sql-hl-text .t-err")).toHaveText(["o", ".", "status"]);
  await expect(page.locator("#join-run")).toBeDisabled();
  expect(requests).toBe(0);
});

test("an unknown table is caught before any request, with a suggestion", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o JOIN user u ON o.user_id = u.id");
  await expect(page.locator("#join-sql-error")).toHaveText("Line 1: There is no table user. Did you mean users?");
  await expect(page.locator("#join-run")).toBeDisabled();
});

test("the form greys columns that cannot pair and says why", async ({ page }) => {
  await openJoinOverlay(page);
  await pick(page, "join 1 table", "users");
  await page.getByRole("button", { name: "join 1: column of users" }).click();
  const menu = page.locator("#dd-pop");
  const email = menu.locator('.dd-row[data-value="email"]');
  await expect(email).toHaveAttribute("aria-disabled", "true");
  await expect(email).toContainText("text ≠ uuid");
  await expect(menu.locator('.dd-row[data-value="metadata"]')).toContainText("jsonb: not joinable");
  await expect(menu.locator('.dd-row[data-value="id"]')).not.toHaveAttribute("aria-disabled", "true");
  await email.click({ force: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".j-ok")).toHaveText("uuid = uuid ✓");
});

test("suggestions after JOIN offer a foreign key clause first, then tables with counts", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o JOIN ");
  const sql = page.locator("#join-sql");
  await sql.press("End");
  await sql.pressSequentially("us");
  const options = page.locator("#join-sql-suggest button");
  await expect(options.first()).toContainText("users u ON o.user_id = u.id");
  await expect(options.first()).toContainText("foreign key");
  await sql.press("Tab");
  await expect(sql).toHaveValue("FROM orders o JOIN users u ON o.user_id = u.id ");
});

test("suggestions after ON x.col = alias. list columns, grey the ones that cannot pair, and tag indexed ones", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o JOIN users u ON o.user_id = ");
  const sql = page.locator("#join-sql");
  await sql.press("End");
  await sql.pressSequentially("u.");
  const options = page.locator("#join-sql-suggest button");
  await expect(options.filter({ hasText: /^id/ })).toContainText("indexed");
  const email = options.filter({ hasText: /^email/ });
  await expect(email).toHaveAttribute("aria-disabled", "true");
  await expect(email).toContainText("text ≠ uuid");
  await expect(options.filter({ hasText: /^metadata/ })).toContainText("jsonb: not joinable");
});

test("a self-join with aliases shows one band per use", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders a JOIN orders b ON a.user_id = b.user_id");
  await showResult(page);
  await expect(page.locator("th.band")).toHaveText(["orders a", "orders b"]);
});

test("a saved join becomes a chip after the table chips that survives a reload and reopens its join", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-name").fill("orders with users");
  await showResult(page);
  await expandTableChips(page);
  const chip = page.locator("#tables li.join-chip button", { hasText: "orders with users" });
  await expect(chip).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#tables li.join-first")).toBeVisible();

  await page.reload();
  await waitForIdle(page);
  await expandTableChips(page);
  await expect(chip).toHaveAttribute("aria-current", "true");

  await selectTable(page, "users");
  await expandTableChips(page);
  await expect(chip).not.toHaveAttribute("aria-current", "true");
  await chip.click();
  await expect(page.locator("#current")).toHaveText("orders o ⟕ users u");
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"]);
});

test("an unsaved join gets a dashed chip with Save…, and its URL reproduces it", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await showResult(page);
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip.unsaved")).toBeVisible();
  await page.locator("#tables li.save-link button").click();
  await expect(page.locator("#join-name")).toBeFocused();
  await page.keyboard.press("Escape");

  const url = page.url();
  expect(new URL(url).searchParams.get("join")).toBe("SELECT *\nFROM orders o\nLEFT JOIN users u ON o.user_id = u.id");
  await expect(page.locator("#join-link-btn")).toBeVisible();
  await gotoApp(page);
  await page.goto(url);
  await waitForIdle(page);
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"]);
});

test("renaming and deleting a saved join from the overlay", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-name").fill("first");
  await showResult(page);
  await page.locator("#join-edit-btn").click();
  await expect(page.locator("#join-name")).toHaveValue("first");
  await page.locator("#join-name").fill("second");
  await showResult(page);
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip button", { hasText: "second" })).toBeVisible();
  await expect(page.locator("#tables li.join-chip button", { hasText: "first" })).toHaveCount(0);

  await page.locator("#join-edit-btn").click();
  await page.locator("#join-delete").click();
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip button", { hasText: "second" })).toHaveCount(0);
  await expect(page.locator("#tables li.join-chip.unsaved")).toBeVisible();
});

test("clicking the chip of the saved join in view opens it for deleting", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-name").fill("kept");
  await showResult(page);
  await expandTableChips(page);
  const chip = page.locator("#tables li.join-chip.saved button", { hasText: "kept" });
  await expect(chip).toHaveAttribute("title", "kept: click to edit, rename or delete");
  await chip.click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-name")).toHaveValue("kept");
  await page.locator("#join-delete").click();
  await expect(page.locator("#join-dialog")).toBeHidden();

  await page.reload();
  await waitForIdle(page);
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip.saved")).toHaveCount(0);
});

test("an empty SQL box disables Show result", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "");
  await expect(page.locator("#join-run")).toBeDisabled();
});

test("switching from the form to SQL keeps a table whose columns are all selected", async ({ page }) => {
  await openJoinOverlay(page);
  await pick(page, "join 1 table", "users");
  await page.getByRole("checkbox", { name: "users.email", exact: true }).uncheck();
  await page.locator("#join-mode-sql").click();
  await expect(page.locator("#join-sql")).toHaveValue(/^SELECT orders\.\*, users\.id, /);
});

test("a select list that alternates tables gets a band per switch", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "SELECT o.id, u.email, o.status FROM orders o JOIN users u ON o.user_id = u.id");
  await showResult(page);
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u", "orders o"]);
});

test("removing the only join cannot be shown", async ({ page }) => {
  await openJoinOverlay(page);
  await page.getByRole("button", { name: "remove join 1", exact: true }).click();
  await page.locator("#join-run").click();
  await expect(page.locator("#join-error")).toHaveText("Add a table to join.");
});

test("the table menu narrows by fuzzy search as you type, and Enter picks the best match", async ({ page }) => {
  await openJoinOverlay(page);
  await page.getByRole("button", { name: "join 1 table", exact: true }).click();
  const search = page.locator("#dd-pop-search");
  await expect(search).toBeFocused();
  await search.fill("ordx");
  await expect(page.locator("#dd-pop .dd-row").first()).toHaveAttribute("data-value", "order_extra");
  await search.fill("zzzzqq");
  await expect(page.locator("#dd-pop .dd-row")).toHaveCount(0);
  await expect(page.locator("#dd-pop .dd-none")).toHaveText("Nothing matches zzzzqq.");
  await search.fill("users");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: "join 1 table", exact: true })).toHaveText("users ▾");
});

test("SQL opened from an unfinished form can go back to Form until its text is edited", async ({ page }) => {
  await openJoinOverlay(page);
  await page.locator("#join-mode-sql").click();
  await expect(page.locator("#join-mode-form")).toBeEnabled();
  await expect(page.locator("#join-sql-error")).toBeEmpty();
  await expect(page.locator("#join-run")).toBeDisabled();
  await page.locator("#join-mode-form").click();
  await expect(page.locator("#join-form-pane")).toBeVisible();
  await expect(page.getByRole("button", { name: "join 1 table", exact: true })).toBeVisible();

  await page.locator("#join-mode-sql").click();
  await page.locator("#join-sql").press("End");
  await page.locator("#join-sql").pressSequentially(" RIGHT");
  await expect(page.locator("#join-mode-form")).toBeDisabled();
});

test("the form suggests the foreign key pair for a table browsed earlier", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  await page.locator("#join-btn").click();
  await pick(page, "join 1 table", "users");
  await expect(page.locator(".j-row").first()).toContainText("Suggested from the foreign key orders.user_id → users.id.");
});

test("saving the join in view keeps its filter, sort and page", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  let response = nextJoinResponse(page);
  await page.locator("#filter").fill("o.id > 1");
  await page.locator("#filter").press("Enter");
  await response;
  await waitForIdle(page);
  response = nextJoinResponse(page);
  await page.locator("thead tr:not(.bands) th[data-col]").first().click();
  await response;
  await waitForIdle(page);
  response = nextJoinResponse(page);
  await page.locator("#next").click();
  await response;
  await waitForIdle(page);

  await expandTableChips(page);
  await page.locator("#tables li.save-link button").click();
  await page.locator("#join-name").fill("kept view");
  const saved = await showResult(page);
  const params = new URL(saved.url()).searchParams;
  expect(params.get("offset")).toBe("5");
  expect(params.get("sort")).toBe("id");
  await expect(page.locator("#filter")).toHaveValue("o.id > 1");
  await expandTableChips(page);
  await expect(page.locator("#tables li.join-chip.saved")).toHaveText("⋈ kept view");
});

test("showing a join again from the form keeps its written column order and its view", async ({ page }) => {
  const text = "SELECT u.full_name, o.id\nFROM orders o\nLEFT JOIN users u ON o.user_id = u.id";
  await gotoJoin(page, text);
  const response = nextJoinResponse(page);
  await page.locator("#filter").fill("o.id > 1");
  await page.locator("#filter").press("Enter");
  await response;
  await waitForIdle(page);

  await page.locator("#join-edit-btn").click();
  await expect(page.locator("#join-mode-form")).toHaveAttribute("aria-selected", "true");
  const again = await showResult(page);
  expect(joinParam(again.url())).toMatchObject({
    columns: [
      { join: 1, column: "full_name" },
      { join: 0, column: "id" },
    ],
  });
  expect(new URL(page.url()).searchParams.get("join")).toBe(text);
  await expect(page.locator("#filter")).toHaveValue("o.id > 1");
});
