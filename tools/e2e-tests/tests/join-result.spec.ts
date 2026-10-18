import { expect, test } from "@playwright/test";
import { waitForIdle } from "./support/helpers";
import { gotoJoin, joinParam, joinUrl, nextJoinResponse, ORDERS_USERS } from "./support/join";

// Story 41: the result of a join in the normal grid.

test("a join view labels columns by table and pages without a total", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await expect(page.locator("th.band")).toHaveText(["orders o", "users u"]);
  await expect(page.locator("#page")).toHaveText("page 1 · more rows available");
  await expect(page.locator("#next")).toBeEnabled();
  await expect(page.locator("#row-meta")).toContainText("5+ rows");
  await expect(page.locator("#row-meta")).not.toContainText("~");
  await expect(page.locator("#structure-btn")).toBeHidden();
  await expect(page.locator("#join-edit-btn")).toBeVisible();
  await expect(page.locator("#join-link-btn")).toBeVisible();

  const response = nextJoinResponse(page);
  await page.locator("#next").click();
  expect(new URL((await response).url()).searchParams.get("offset")).toBe("5");
  await waitForIdle(page);
  await expect(page.locator("#page")).toContainText("page 2");
});

test("the last page says so and disables next", async ({ page }) => {
  await gotoJoin(page, "FROM orders o JOIN order_extra x ON x.order_id = o.id", 100);
  await expect(page.locator("#page")).toHaveText("page 1 · last page");
  await expect(page.locator("#next")).toBeDisabled();
});

test("sorting and filtering on a joined column send its table position", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  let response = nextJoinResponse(page);
  await page.locator('th[data-col="full_name"]').click({ position: { x: 6, y: 6 } });
  let url = new URL((await response).url());
  expect(url.searchParams.get("sort")).toBe("full_name");
  expect(url.searchParams.get("sort_join")).toBe("1");
  await waitForIdle(page);
  await expect(page.locator('th[data-col="full_name"]')).toHaveAttribute("aria-sort", "ascending");

  response = nextJoinResponse(page);
  await page.locator("#filter").fill("u.is_active = true AND status = completed");
  await page.locator("#filter").press("Enter");
  url = new URL((await response).url());
  expect(JSON.parse(url.searchParams.get("filter") as string)).toEqual([
    { column: "is_active", join: 1, op: "=", value: "true" },
    { logic: "AND", column: "status", join: 0, op: "=", value: "completed" },
  ]);
  await waitForIdle(page);
  await expect(page.locator("#error")).toBeEmpty();
});

test("filter by this value on a joined cell writes alias.column", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  const cell = page.locator('#tbody tr').first().locator('td[data-col="email"]');
  await cell.hover();
  const response = nextJoinResponse(page);
  await cell.locator(".filter-eq").click();
  await response;
  await expect(page.locator("#filter")).toHaveValue(/^u\.email = /);
});

test("a qualifier that is not in the join is a filter error, not a request", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.locator("#filter").fill("z.status = x");
  await page.locator("#filter").press("Enter");
  await expect(page.locator("#error")).toContainText("unknown table alias z");
});

test("the record dialog groups a joined row by table", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-dl dt.record-group")).toHaveText(["orders", "users"]);
  await expect(page.locator("#record-copy-insert")).toBeHidden();
  await expect(page.locator("#record-referenced-by-wrap")).toBeHidden();
});

test("the server's 400 for a join it refuses shows in the overlay", async ({ page }) => {
  const response = nextJoinResponse(page);
  await page.goto(joinUrl("FROM orders o JOIN users u ON o.status = u.id"));
  expect((await response).status()).toBe(400);
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-error")).toContainText("cannot be joined");
});

test("a timeout offers Retry and Edit join", async ({ page }) => {
  await page.route("**/api/tables/join*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "query timed out", status: 500, code: "query_timeout" }),
    }),
  );
  await page.goto(joinUrl(ORDERS_USERS));
  await expect(page.locator("#join-notice")).toContainText("took longer than the time limit");
  await expect(page.locator("#error")).toBeEmpty();

  await page.unroute("**/api/tables/join*");
  const response = nextJoinResponse(page);
  await page.locator("#join-notice").getByRole("button", { name: "Retry" }).click();
  expect((await response).status()).toBe(200);
  await waitForIdle(page);
  await expect(page.locator("#join-notice")).toBeHidden();
});

test("an inner join with no match shows an empty state that offers a left join", async ({ page }) => {
  await gotoJoin(page, "FROM orders o JOIN users u ON o.id = u.id");
  const empty = page.locator("#tbody .empty-join");
  await expect(empty).toContainText("No rows match this join.");
  await expect(empty).toContainText("An inner join drops rows without a match. A left join keeps them.");
  const response = nextJoinResponse(page);
  await empty.getByRole("button", { name: "Switch to left join" }).click();
  const join = joinParam((await response).url()) as { joins: { type: string }[] };
  expect(join.joins.map((j) => j.type)).toEqual(["left"]);
  await waitForIdle(page);
  await expect(page.locator("#tbody .empty-join")).toHaveCount(0);
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("leaving a join view for a table chip drops the join, back returns to it", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.locator('#tables button[data-table="users"]').click();
  await expect(page.locator("#current")).toHaveText("users");
  await waitForIdle(page);
  await expect(page.locator("th.band")).toHaveCount(0);
  await expect(page.locator("#join-btn")).toBeVisible();
  await page.locator("#nav-back").click();
  await expect(page.locator("#current")).toHaveText("orders o ⟕ users u");
  await waitForIdle(page);
  await expect(page.locator("th.band")).toHaveCount(2);
});

test("a filter on a column the join lacks is reported by the error line, not the join overlay", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  const response = nextJoinResponse(page);
  await page.locator("#filter").fill("o.no_such_column = x");
  await page.locator("#filter").press("Enter");
  expect((await response).status()).toBe(400);
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#join-dialog")).toBeHidden();
});
