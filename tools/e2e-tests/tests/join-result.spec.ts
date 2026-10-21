import { expect, test } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";
import { gotoJoin, joinParam, joinUrl, nextJoinResponse, ORDERS_USERS, writeSql } from "./support/join";

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

test("a join the server rejects after it has loaded still opens the join overlay", async ({ page }) => {
  await gotoJoin(page, ORDERS_USERS);
  await page.route("**/api/tables/join*", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "invalid join: users has no column \"id\"", status: 400, code: "invalid_join" }),
    }),
  );
  await page.locator("#refresh").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-error")).toContainText('users has no column "id"');
  await expect(page.locator("#error")).toBeEmpty();
});

function problem(status: number, code: string, title: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({ type: "about:blank", title, status, code }),
  };
}

test("a join that times out is asked once and keeps a shared link's filter", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/tables/join*", (route) => {
    requests++;
    return route.fulfill(problem(500, "query_timeout", "query timed out"));
  });
  await page.goto(`${joinUrl(ORDERS_USERS)}&filter=${encodeURIComponent("o.id > 1")}`);
  await expect(page.locator("#join-notice")).toBeVisible();
  await waitForIdle(page);
  expect(requests).toBe(1);
  await expect(page.locator("#filter")).toHaveValue("o.id > 1");
});

test("cancelling a join the server refuses goes back to the table in view", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.route("**/api/tables/join*", (route) =>
    route.fulfill(problem(400, "invalid_join", "invalid join: these columns cannot be joined")),
  );
  await page.locator("#join-btn").click();
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-run").click();
  await expect(page.locator("#join-error")).toContainText("cannot be joined");
  await page.locator("#join-cancel").click();
  await expect(page.locator("#current")).toHaveText("orders");

  // Later actions ask for the table again, not the refused join.
  const response = page.waitForResponse((r) => r.url().includes("/api/tables/data"));
  await page.locator('th[data-col="id"]').click();
  expect((await response).status()).toBe(200);
  await waitForIdle(page);
  await expect(page.locator("#join-dialog")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("join")).toBeNull();
});

test("a new join that times out leaves the table in view as it was", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.route("**/api/tables/join*", (route) => route.fulfill(problem(500, "query_timeout", "query timed out")));
  await page.locator("#join-btn").click();
  await writeSql(page, ORDERS_USERS);
  await page.locator("#join-run").click();
  await expect(page.locator("#join-notice")).toBeVisible();
  await expect(page.locator("#current")).toHaveText("orders");

  const response = page.waitForResponse((r) => r.url().includes("/api/tables/data"));
  await page.locator('th[data-col="id"]').click();
  expect((await response).status()).toBe(200);
  await waitForIdle(page);
  expect(new URL(page.url()).searchParams.get("join")).toBeNull();
});

test("a join still loading when the schema changes is dropped, not shown under the new schema", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  let releaseJoin = () => {};
  const joinHeld = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  await page.route("**/api/tables/join*", async (route) => {
    await joinHeld;
    await route.continue();
  });
  // Hold the new schema's table list, so the old join answers before the new schema loads anything.
  let releaseTables = () => {};
  const tablesHeld = new Promise<void>((resolve) => {
    releaseTables = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith("/api/tables") && url.searchParams.get("schema") === "warehouse",
    async (route) => {
      await tablesHeld;
      await route.continue();
    },
  );

  await page.locator("#join-btn").click();
  await writeSql(page, ORDERS_USERS);
  const joinSent = page.waitForRequest((r) => r.url().includes("/api/tables/join"));
  await page.locator("#join-run").click();
  await joinSent;
  const tablesSent = page.waitForRequest((r) => r.url().includes("/api/tables?") && r.url().includes("warehouse"));
  await page.locator("#schema-select").selectOption("warehouse");
  await tablesSent;

  const joinAnswered = nextJoinResponse(page);
  releaseJoin();
  await (await joinAnswered).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(new URL(page.url()).searchParams.get("join")).toBeNull();

  const loaded = page.waitForResponse((r) => r.url().includes("/api/tables/data") && r.url().includes("warehouse"));
  releaseTables();
  await loaded;
  await waitForIdle(page);
  expect(new URL(page.url()).searchParams.get("join")).toBeNull();
  // One step back is the table before the switch, with no join under the new schema in between.
  await page.locator("#nav-back").click();
  await expect(page.locator("#current")).toHaveText("orders");
  expect(new URL(page.url()).searchParams.get("schema")).toBe("public");
});
