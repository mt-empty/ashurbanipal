import { expect, test } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";
import { joinParam, openJoinOverlay, showResult, writeSql, ORDERS_USERS } from "./support/join";

// Story 41: the join overlay, in its Form and SQL modes. Backend: the seed's
// orders -> users (FK) and order_extra -> orders (FK, 1:1).

const ORDERS_USERS_EXTRA = {
  table: "orders",
  joins: [
    { type: "left", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] },
    { type: "left", table: "order_extra", on: [{ left: { join: 0, column: "id" }, right: "order_id" }] },
  ],
};

test("the form builds a three-table join from foreign key hints and sends it", async ({ page }) => {
  await openJoinOverlay(page);
  await page.getByLabel("join 1 type").selectOption("left");
  await page.getByLabel("join 1 table").selectOption("users");
  await page.getByRole("button", { name: "use the foreign key between orders and users" }).click();
  await page.getByRole("button", { name: "add a table to the join" }).click();
  await page.getByLabel("join 2 type").selectOption("left");
  await page.getByLabel("join 2 table").selectOption("order_extra");
  await page.getByRole("button", { name: "use the foreign key between orders and order_extra" }).click();
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

test("the SQL text builds the same join and switching modes keeps the definition", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "from orders left join users on users.id = orders.user_id\nleft join order_extra on order_extra.order_id = orders.id");
  await page.locator("#join-mode-form").check();
  await expect(page.getByLabel("join 2 table")).toHaveValue("order_extra");
  await expect(page.locator("#join-preview")).toContainText("LEFT JOIN users ON orders.user_id = users.id");
  await page.locator("#join-mode-sql").check();
  await expect(page.locator("#join-sql")).toHaveValue(/^SELECT \*\nFROM orders\nLEFT JOIN users ON orders\.user_id = users\.id\nLEFT JOIN order_extra/);

  const response = await showResult(page);
  expect(joinParam(response.url())).toEqual(ORDERS_USERS_EXTRA);
});

test("text that does not parse disables Form and says where and why", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o\nRIGHT JOIN users u ON o.user_id = u.id");
  await expect(page.locator("#join-mode-form")).toBeDisabled();
  await expect(page.locator("#join-sql-error")).toContainText("line 2, column 1");
  await expect(page.locator("#join-sql-error")).toContainText("RIGHT JOIN is not supported");

  await page.locator("#join-sql").fill(ORDERS_USERS);
  await expect(page.locator("#join-mode-form")).toBeEnabled();
  await expect(page.locator("#join-sql-error")).toBeEmpty();
});

test("an unknown table or column is caught before any request, with a suggestion", async ({ page }) => {
  await openJoinOverlay(page);
  let requests = 0;
  await page.route("**/api/tables/join*", (route) => {
    requests++;
    return route.continue();
  });
  await writeSql(page, "FROM orders o JOIN user u ON o.user_id = u.id");
  await page.locator("#join-run").click();
  await expect(page.locator("#join-error")).toContainText('did you mean "users"');
  expect(requests).toBe(0);
});

test("the form greys columns that cannot pair and says why", async ({ page }) => {
  await openJoinOverlay(page);
  await page.getByLabel("join 1 table").selectOption("users");
  await page.getByLabel("join 1: column of an earlier table").selectOption("0|status");
  const id = page.getByLabel("join 1: column of users").locator("option", { hasText: /^id \(uuid\)/ });
  await expect(id).toBeDisabled();
  await expect(id).toHaveText(/uuid ≠ custom type/);
  await page.getByLabel("join 1: column of an earlier table").selectOption("0|user_id");
  await expect(page.getByLabel("join 1: column of users").locator("option", { hasText: /^id \(uuid\)/ })).toBeEnabled();
  await expect(page.getByLabel("join 1: column of users").locator("option", { hasText: /^metadata/ })).toBeDisabled();
});

test("suggestions after JOIN offer tables and a foreign key clause", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o JOIN ");
  const sql = page.locator("#join-sql");
  await sql.press("End");
  await sql.pressSequentially("us");
  const options = page.locator("#join-sql-suggest button");
  await expect(options.first()).toHaveText("users ON o.user_id = users.id");
  await expect(options.nth(1)).toHaveText("users");
  await sql.press("Tab");
  await expect(sql).toHaveValue("FROM orders o JOIN users ON o.user_id = users.id ");
});

test("suggestions after ON x.col = alias. list columns, grey the ones that cannot pair, and tag indexed ones", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, "FROM orders o JOIN users u ON o.user_id = ");
  const sql = page.locator("#join-sql");
  await sql.press("End");
  await sql.pressSequentially("u.");
  const options = page.locator("#join-sql-suggest button");
  await expect(options.filter({ hasText: /^id \(uuid\)/ })).toHaveText(/indexed/);
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

test("a saved join becomes a chip that survives a reload and reopens its join", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-name").fill("orders with users");
  await showResult(page);
  const chip = page.locator("#saved-joins button", { hasText: "orders with users" });
  await expect(chip).toHaveAttribute("aria-current", "true");

  await page.reload();
  await waitForIdle(page);
  await expect(chip).toHaveAttribute("aria-current", "true");

  await selectTable(page, "users");
  await expect(chip).not.toHaveAttribute("aria-current", "true");
  await chip.click();
  await expect(page.locator("#current")).toHaveText("orders o ⟕ users u");
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"]);
});

test("an unsaved join gets a dashed chip with Save…, and its URL reproduces it", async ({ page }) => {
  await openJoinOverlay(page);
  await writeSql(page, ORDERS_USERS);
  await showResult(page);
  await expect(page.locator("#saved-joins li.unsaved")).toBeVisible();
  await page.locator("#saved-joins li.save-link button").click();
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
  await expect(page.locator("#saved-joins button", { hasText: "second" })).toBeVisible();
  await expect(page.locator("#saved-joins button", { hasText: "first" })).toHaveCount(0);

  await page.locator("#join-edit-btn").click();
  await page.locator("#join-delete").click();
  await expect(page.locator("#saved-joins button", { hasText: "second" })).toHaveCount(0);
  await expect(page.locator("#saved-joins li.unsaved")).toBeVisible();
});
