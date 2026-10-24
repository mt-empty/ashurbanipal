import { test, expect, type Route } from "./support/fixtures";
import { APP_PATH, gotoApp, selectTable } from "./support/helpers";
import { freePort, spawnDemo } from "./support/second-server";

test("a failed load leaves the previous table's rows and active state untouched", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  const firstIdBefore = await page
    .locator('#tbody tr').first().locator('td[data-col="id"] .cell-text')
    .textContent();

  await page.route("**/api/tables/data*", (route) => route.abort("failed"));
  await page.locator('#tables [data-table="users"]').click();
  await expect(page.locator("#error")).not.toBeEmpty();

  // Chrome/status must still describe the table that's actually rendered.
  await expect(page.locator("#current")).toHaveText("orders");
  await expect(page.locator('#tables [data-table="orders"]')).toHaveClass(/active/);
  await expect(page.locator('#tables [data-table="users"]')).not.toHaveClass(/active/);
  const firstIdAfter = await page
    .locator('#tbody tr').first().locator('td[data-col="id"] .cell-text')
    .textContent();
  expect(firstIdAfter).toBe(firstIdBefore);
});

test("a slow, superseded response never overwrites a newer table's render", async ({ page }) => {
  // Regression test for a real bug (fixed): forces the exact
  // out-of-order race — an older request for "orders" is delayed so it
  // resolves *after* a newer request for "users" has already rendered.
  // loadData()'s token guard should discard the late "orders" response
  // outright rather than letting it overwrite "users"'s already-current
  // grid/chrome.
  await gotoApp(page);
  let releaseOrders!: () => void;
  const ordersHeld = new Promise<void>((r) => (releaseOrders = r));
  await page.route("**/api/tables/data*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("table") === "orders") await ordersHeld;
    await route.continue();
  });

  // Registered before the triggering click: waitForResponse listens for the
  // next matching response event, so it has to be armed before the request
  // that fires it, not polled for after the fact.
  const staleOrdersResponse = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get("table") === "orders",
  );
  await page.locator('#tables [data-table="orders"]').click(); // slow, started first
  await page.locator('#tables [data-table="users"]').click(); // fast, resolves first
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  releaseOrders();

  // Wait for the delayed "orders" response to actually land before
  // asserting nothing changed — otherwise this could pass without ever
  // exercising the race it's a regression test for.
  await staleOrdersResponse;

  await expect(page.locator("#current")).toHaveText("users");
  await expect(page.locator('#tables [data-table="users"]')).toHaveClass(/active/);
  await expect(page.locator('#tbody td[data-col="email"]').first()).toBeVisible();
  await expect(page.locator('#tbody td[data-col="status"]')).toHaveCount(0); // orders' column
});

test("a missing protocol header warns non-blockingly and is dismissible", async ({ page }) => {
  // Simulates a version-skewed backend by stripping the header the real
  // server always sends — a missing header counts as a mismatch too. A
  // predicate, not a glob string: the seed DB can carry more than one
  // schema, in which case /tables picks up a `?schema=` query string, and a
  // plain "**/api/tables" glob (no trailing wildcard) stops matching a
  // querystring'd URL — this matches on pathname alone, same as the other
  // routes' "**/api/tables/data*" wildcard already does for their query.
  await page.route((url) => url.pathname.endsWith("/api/tables"), async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["x-ashurbanipal-protocol"];
    await route.fulfill({ response, headers });
  });
  await gotoApp(page);
  await expect(page.locator("#protocol-warning")).toBeVisible();
  await expect(page.locator("#protocol-warning-text")).toContainText("mismatch");
  // Non-blocking: browsing still works underneath the warning.
  await expect(page.locator("#tbody tr").first()).toBeVisible();
  await page.locator("#protocol-warning-dismiss").click();
  await expect(page.locator("#protocol-warning")).toBeHidden();
});

test("no protocol warning appears against a matching backend", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("#protocol-warning")).toBeHidden();
});

test("errors are surfaced as a visible role=alert region, not just logged", async ({ page }) => {
  // An invalid sort column fails the first load, so no table chip ever becomes active for gotoApp to wait on.
  await page.goto(`${APP_PATH}?table=orders&sort=nonexistent_col`);
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(page.locator("#error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#error")).toBeVisible();
});

// spec/protocol.md makes /sources and /schemas mandatory; a failing one degrades to a single source or schema (R5).
const serverError = (route: Route) =>
  route.fulfill({
    status: 500,
    contentType: "application/problem+json",
    body: JSON.stringify({ type: "about:blank", title: "Internal Server Error", status: 500 }),
  });

test("a failing /sources hides the source picker and the tables still load", async ({ page }) => {
  const demo = await spawnDemo({ port: await freePort(), conformanceSecondSource: true });
  try {
    await page.route((url) => url.pathname.endsWith("/api/sources"), serverError);
    await page.goto(`${demo.baseUrl}${APP_PATH}`);
    await page.locator("#tables [data-table].active").waitFor();
    await expect(page.locator("#source-select-wrap")).toBeHidden();
    await expect(page.locator("#error")).toBeEmpty();
    await expect(page.locator("#tbody tr").first()).toBeVisible();
  } finally {
    await demo.stop();
  }
});

test("a failing /schemas hides the schema picker and the tables still load", async ({ page }) => {
  await page.route((url) => url.pathname.endsWith("/api/schemas"), serverError);
  await gotoApp(page);
  await expect(page.locator("#schema-select-wrap")).toBeHidden();
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});
