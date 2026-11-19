import { expect, test } from "./support/fixtures";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

// The highlight diffs against the *previous* /tables/data response, so
// every test mocks that route with a mutable body: seed it, load the
// table, swap the body, then refresh. `users` is just a table the chip list
// lists — the mock replaces its payload wholesale.

type Cell = number | string;

function payload(rows: Cell[][]) {
  return {
    columns: [
      { name: "id", type: "integer", class: "number", key: "pk" },
      { name: "label", type: "text", class: "text" },
    ],
    rows: rows.map(([id, label]) => ({ id: String(id), label: String(label) })),
    total_approx: rows.length,
  };
}

function payloadNoPk(rows: Cell[][]) {
  return {
    ...payload(rows),
    columns: [
      { name: "id", type: "integer", class: "number" },
      { name: "label", type: "text", class: "text" },
    ],
  };
}

// Static tints: grid.ts drops .cell-changed when its 3 s fade ends, and
// waitForIdle does not wait that out, so a fading tint could race an assertion.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const rowFor = (page: import("@playwright/test").Page, id: string) =>
  page.locator("#tbody tr").filter({
    has: page.locator('td[data-col="id"] .cell-text', { hasText: new RegExp(`^${id}$`) }),
  });

test("refresh tints a row that appeared since the last fetch, leaving the rest untouched", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payload([
    [1, "a"],
    [2, "b"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");
  await expect(page.locator("#tbody tr")).toHaveCount(2);

  body = payload([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody tr")).toHaveCount(3);
  await expect(rowFor(page, "3")).toHaveClass(/row-new/);
  await expect(rowFor(page, "1")).not.toHaveClass(/row-new/);
  await expect(rowFor(page, "2")).not.toHaveClass(/row-new/);
  await expect(page.locator("#status")).toHaveText("1 new");
  await expect(page.locator("#row-new-chip")).toHaveText("+1 new");
});

test("refresh with no change highlights nothing", async ({ page }) => {
  await gotoApp(page);
  const body = payload([
    [1, "a"],
    [2, "b"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  await page.locator("#refresh").click();
  await waitForIdle(page);
  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
  // No tint fired, so #status carries the "done, unchanged" cue instead.
  await expect(page.locator("#status")).toHaveText("no changes");
  await expect(page.locator("#row-updated")).toContainText(/updated \d{2}:\d{2}:\d{2}/);
  await expect(page.locator("#refresh-icon")).not.toHaveText("✓");
});

test("a table with no primary key gets no highlight on refresh", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadNoPk([
    [1, "a"],
    [2, "b"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadNoPk([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody tr")).toHaveCount(3);
  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
});

test("a sort change is not treated as new rows", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payload([
    [1, "a"],
    [2, "b"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  // Different rows AND a scope change — a sort click never passes
  // highlightNew, and scopeKey no longer matches, so neither path tints.
  body = payload([
    [3, "c"],
    [1, "a"],
    [2, "b"],
  ]);
  await page.locator('th[data-col="label"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);

  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
});

// Three columns, so a change can sit in one cell of a row and a column can
// be hidden while another stays shown.
function payloadWithNote(rows: [number, string, string | null][]) {
  return {
    columns: [
      { name: "id", type: "integer", class: "number", key: "pk" },
      { name: "label", type: "text", class: "text" },
      { name: "note", type: "text", class: "text" },
    ],
    rows: rows.map(([id, label, note]) => ({ id: String(id), label, note })),
    total_approx: rows.length,
  };
}

const cellOf = (page: import("@playwright/test").Page, id: string, col: string) =>
  rowFor(page, id).locator(`td[data-col="${col}"]`);

test("refresh tints exactly the cell whose value changed", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadWithNote([
    [1, "a", "x"],
    [2, "b", "y"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadWithNote([
    [1, "a", "x"],
    [2, "b2", "y"],
  ]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody td.cell-changed")).toHaveCount(1);
  await expect(cellOf(page, "2", "label")).toHaveClass(/cell-changed/);
  await expect(page.locator("#tbody tr.row-new")).toHaveCount(0);
  await expect(page.locator("#status")).toHaveText("1 changed");
  await expect(page.locator("#row-changed-chip")).toHaveText("1 changed");
  await expect(page.locator("#row-new-chip")).toBeHidden();
});

test("a new row and an edited row show both tints and both chips, counting rows", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadWithNote([
    [1, "a", "x"],
    [2, "b", "y"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  // Row 1 changes in two cells and counts once; null to "" is a change.
  body = payloadWithNote([
    [1, "a2", null],
    [2, "b", "y"],
    [3, "c", ""],
  ]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(rowFor(page, "3")).toHaveClass(/row-new/);
  await expect(rowFor(page, "3").locator("td.cell-changed")).toHaveCount(0);
  await expect(cellOf(page, "1", "label")).toHaveClass(/cell-changed/);
  await expect(cellOf(page, "1", "note")).toHaveClass(/cell-changed/);
  await expect(rowFor(page, "2").locator("td.cell-changed")).toHaveCount(0);
  await expect(page.locator("#row-new-chip")).toHaveText("+1 new");
  await expect(page.locator("#row-changed-chip")).toHaveText("1 changed");
  await expect(page.locator("#status")).toHaveText("1 new · 1 changed");
});

test("a change only in a hidden column gets no tint, and the chip says where it is", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadWithNote([
    [1, "a", "x"],
    [2, "b", "y"],
  ]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");
  await page.locator("#columns-btn").click();
  await page.locator('#columns-pop-list label[data-name="note"] input').uncheck();
  await page.keyboard.press("Escape");

  body = payloadWithNote([
    [1, "a", "x"],
    [2, "b", "y2"],
  ]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody td.cell-changed")).toHaveCount(0);
  await expect(page.locator("#row-changed-chip")).toHaveText("1 changed in a hidden column");
  await expect(page.locator("#status")).toHaveText("1 changed in a hidden column");

  // Shown again, the cell must not replay a tint it never had.
  await page.locator("#columns-btn").click();
  await page.locator('#columns-pop-list label[data-name="note"] input').check();
  await expect(cellOf(page, "2", "note")).toBeVisible();
  await expect(cellOf(page, "2", "note")).not.toHaveClass(/cell-changed/);
});

test("hiding a column drops its tint, so showing it again does not replay it", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadWithNote([[1, "a", "x"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadWithNote([[1, "a", "x2"]]);
  await page.locator("#refresh").click();
  await waitForIdle(page);
  const cell = cellOf(page, "1", "note");
  await expect(cell).toHaveClass(/cell-changed/);

  const toggle = page.locator('#columns-pop-list label[data-name="note"] input');
  await page.locator("#columns-btn").click();
  await toggle.uncheck();
  await toggle.check();
  await expect(cell).toBeVisible();
  await expect(cell).not.toHaveClass(/cell-changed/);
});

test("a changed cell drops its tint once the fade ends", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await gotoApp(page);
  let body: unknown = payloadWithNote([[1, "a", "x"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadWithNote([[1, "a2", "x"]]);
  await page.locator("#refresh").click();
  await waitForIdle(page);
  const cell = cellOf(page, "1", "label");
  await expect(cell).toHaveClass(/cell-changed/);

  // Finishing the animation fires animationend without a 3 s wait.
  await cell.evaluate((td) => {
    for (const a of td.getAnimations()) a.finish();
  });
  await expect(cell).not.toHaveClass(/cell-changed/);
});

test("a table with no primary key gets no changed-cell tint", async ({ page }) => {
  await gotoApp(page);
  let body: unknown = payloadNoPk([[1, "a"]]);
  await page.route("**/api/tables/data*", (r) => r.fulfill({ json: body }));
  await selectTable(page, "users");

  body = payloadNoPk([[1, "b"]]);
  await page.locator("#refresh").click();
  await waitForIdle(page);

  await expect(page.locator("#tbody td.cell-changed")).toHaveCount(0);
  await expect(page.locator("#row-changed-chip")).toBeHidden();
});
