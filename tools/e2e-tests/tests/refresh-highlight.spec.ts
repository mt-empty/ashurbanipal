import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

// The highlight diffs against the *previous* /tables/data response, so
// every test mocks that route with a mutable body: seed it, load the
// table, swap the body, then refresh. `users` is just a table the sidebar
// lists — the mock replaces its payload wholesale.

type Cell = number | string;

function payload(rows: Cell[][]) {
  return {
    columns: [
      { name: "id", type: "integer", key: "pk" },
      { name: "label", type: "text" },
    ],
    rows: rows.map(([id, label]) => ({ id: String(id), label: String(label) })),
    total_approx: rows.length,
  };
}

function payloadNoPk(rows: Cell[][]) {
  return { ...payload(rows), columns: [
    { name: "id", type: "integer" },
    { name: "label", type: "text" },
  ] };
}

const rowFor = (page: import("@playwright/test").Page, id: string) =>
  page.locator("#tbody tr").filter({
    has: page.locator('td[data-col="id"] .cell-text', { hasText: new RegExp(`^${id}$`) }),
  });

test("refresh tints a row that appeared since the last fetch, leaving the rest untouched", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payload([[1, "a"], [2, "b"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");
  await expect(page.locator("#tbody tr")).toHaveCount(2);

  body = payload([[1, "a"], [2, "b"], [3, "c"]]);
  await page.locator("#refresh").click();
  await expect(page.locator("#refresh")).toHaveClass(/spinning/); // click acknowledged
  await waitForIdle(page);

  await expect(page.locator("#tbody tr")).toHaveCount(3);
  await expect(rowFor(page, "3")).toHaveClass(/row-new/);
  await expect(rowFor(page, "1")).not.toHaveClass(/row-new/);
  await expect(rowFor(page, "2")).not.toHaveClass(/row-new/);
  await expect(page.locator("#status")).toHaveText("1 new");
});

test("refresh with no change highlights nothing", async ({ page }) => {
  await gotoApp(page);
  const body = payload([[1, "a"], [2, "b"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  await page.locator("#refresh").click();
  await waitForIdle(page);
  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
  // No tint fired, so the button carries the "done, unchanged" cue itself.
  await expect(page.locator("#refresh-icon")).toHaveText("✓");
  await expect(page.locator("#status")).toHaveText("no changes");
});

test("a table with no primary key gets no highlight on refresh", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadNoPk([[1, "a"], [2, "b"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadNoPk([[1, "a"], [2, "b"], [3, "c"]]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody tr")).toHaveCount(3);
  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
});

test("a sort change is not treated as new rows", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payload([[1, "a"], [2, "b"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  // Different rows AND a scope change — a sort click never passes
  // highlightNew, and scopeKey no longer matches, so neither path tints.
  body = payload([[3, "c"], [1, "a"], [2, "b"]]);
  await page.locator('th[data-col="label"]').click();
  await waitForIdle(page);

  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
});
