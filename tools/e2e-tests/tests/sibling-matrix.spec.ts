import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, problem, selectTable } from "./support/helpers";

// The service × label grid in Other services (story 03 §4.3). /api/siblings is
// mocked: the shape is what matters here, and spec/protocol.md §5.6's server
// side is covered by conformance/runner/labelled_siblings.rs.

const base = (name: string, label: string) => `https://${name}-${label}.example/__ashurbanipal`;

const LABELLED = {
  instance: { name: "orders", label: "dev" },
  siblings: [
    { name: "orders", label: "dev", base_url: base("orders", "dev"), healthy: true },
    { name: "orders", label: "int", base_url: base("orders", "int"), healthy: true },
    { name: "billing", label: "dev", base_url: base("billing", "dev"), healthy: true },
    { name: "billing", label: "int", base_url: base("billing", "int"), healthy: false },
    { name: "users", label: "dev", base_url: base("users", "dev"), healthy: true },
  ],
};

async function mockSiblings(page: Page, body: unknown) {
  await page.route("**/api/siblings", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function openMatrix(page: Page) {
  await page.locator("#siblings-btn").click();
  await expect(page.locator("#siblings-matrix")).toBeVisible();
}

const cell = (page: Page, row: string, col: number) =>
  page.locator("#siblings-matrix-body tr").filter({ has: page.locator(`th:has-text("${row}")`) }).locator("td").nth(col);

test("rows and columns follow the list, and this instance is marked", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page);
  await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down");
  await openMatrix(page);

  await expect(page.locator("#siblings-matrix-head th[scope=col]")).toHaveText(["dev", "int"]);
  await expect(page.locator("#siblings-matrix-body th[scope=row] .sibling-name")).toHaveText([
    "orders",
    "billing",
    "users",
  ]);
  await expect(cell(page, "orders", 0)).toHaveText("you are here");
  await expect(cell(page, "orders", 0).locator("a")).toHaveCount(0);
  await expect(cell(page, "orders", 0).locator("[aria-current=page]")).toHaveCount(1);
  await expect(cell(page, "billing", 1)).toHaveText("down");
  await expect(cell(page, "users", 1)).toHaveText("not set up");
  await expect(cell(page, "users", 1).locator("a")).toHaveCount(0);
  await expect(page.locator("#siblings-matrix th.mine")).toHaveText(["dev", "ordersthis service"]);
});

test("another instance sharing the list sees the same columns and rows", async ({ page }) => {
  await mockSiblings(page, { ...LABELLED, instance: { name: "orders", label: "int" } });
  await gotoApp(page);
  await openMatrix(page);
  await expect(page.locator("#siblings-matrix-head th[scope=col]")).toHaveText(["dev", "int"]);
  await expect(page.locator("#siblings-matrix-body th[scope=row] .sibling-name")).toHaveText([
    "orders",
    "billing",
    "users",
  ]);
  await expect(cell(page, "orders", 1)).toHaveText("you are here");
  await expect(cell(page, "orders", 0)).toHaveText("same view · up");
  await expect(page.locator("#siblings-matrix-head th.mine")).toHaveText("int");
});

test("every cell is a plain link that switches this tab", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page);
  await openMatrix(page);

  const links = page.locator("#siblings-matrix a");
  await expect(links).toHaveCount(4);
  for (const link of await links.all()) {
    await expect(link).not.toHaveAttribute("target", /.*/);
    await expect(link).toHaveAttribute("rel", "noopener");
  }
  await expect(cell(page, "billing", 0).locator("a")).toHaveAttribute("href", base("billing", "dev"));
});

test("the same-view link carries the current view and follows it", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page, "?table=orders");
  await openMatrix(page);
  const sameView = cell(page, "orders", 1).locator("a");
  await expect(sameView).toHaveText("same view · up");
  await expect(sameView).toHaveAttribute("href", base("orders", "int") + new URL(page.url()).search);

  await page.keyboard.press("Escape");
  await selectTable(page, "products");
  await openMatrix(page);
  expect(new URL(page.url()).searchParams.get("table")).toBe("products");
  await expect(sameView).toHaveAttribute("href", base("orders", "int") + new URL(page.url()).search);
});

test("a poll that changes only health keeps focus on the link", async ({ page }) => {
  await page.clock.install();
  let healthy = true;
  await page.route("**/api/siblings", (r) => {
    const body = structuredClone(LABELLED);
    const billingDev = body.siblings.find((s) => s.name === "billing" && s.label === "dev");
    if (billingDev) billingDev.healthy = healthy;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await gotoApp(page);
  await expect(page.locator("#siblings")).toBeVisible();
  await openMatrix(page);
  const link = cell(page, "billing", 0).locator("a");
  await link.focus();

  healthy = false;
  const polled = page.waitForResponse((r) => r.url().includes("/api/siblings"));
  await page.clock.runFor(15_000);
  await polled;
  await expect(link).toHaveText("down");
  await expect(link).toBeFocused();
});

test("the fallback note names this instance's label", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page, "?table=nosuchtable");
  const shown = (await page.locator("#current").textContent()) ?? "";
  await expect(page.locator("#view-notice-text")).toHaveText(
    `There is no table nosuchtable in dev. Showing ${shown} instead.`,
  );
});

test("labels without an instance still show the grid, with nothing marked", async ({ page }) => {
  await mockSiblings(page, { siblings: LABELLED.siblings });
  await gotoApp(page);
  await openMatrix(page);
  await expect(page.locator("#siblings-matrix [aria-current=page]")).toHaveCount(0);
  await expect(page.locator("#siblings-matrix .sibling-cell.same")).toHaveCount(0);
});

test("a closed pop-up never polls, and reopening within 15 s reuses the last result", async ({ page }) => {
  await page.clock.install();
  await mockSiblings(page, LABELLED);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/siblings")) requests++;
  });
  await gotoApp(page);
  await expect(page.locator("#siblings")).toBeVisible();
  expect(requests).toBe(1); // the page-load fetch

  for (let i = 0; i < 3; i++) {
    await openMatrix(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#siblings-matrix")).toBeHidden();
  }
  expect(requests).toBe(1);

  await page.clock.runFor(60_000);
  expect(requests).toBe(1);

  const refreshed = page.waitForResponse((r) => r.url().includes("/api/siblings"));
  await openMatrix(page);
  await refreshed;
  expect(requests).toBe(2);
});

test("the heading says when the list was last updated", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page);
  await openMatrix(page);
  const updated = page.locator("#siblings-heading time");
  await expect(updated).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator("#siblings-heading")).toContainText("Updated ");
});

test("a failed first fetch retries on its own", async ({ page }) => {
  await page.clock.install();
  let fail = true;
  await page.route("**/api/siblings", (r) =>
    fail
      ? r.fulfill(problem(500, "boom", "database_error"))
      : r.fulfill({ contentType: "application/json", body: JSON.stringify(LABELLED) }),
  );
  const failed = page.waitForResponse((r) => r.url().includes("/api/siblings"));
  await gotoApp(page);
  await failed;
  await expect(page.locator("#siblings")).toBeHidden();

  fail = false;
  const retried = page.waitForResponse((r) => r.url().includes("/api/siblings") && r.ok());
  await page.clock.runFor(15_000);
  await retried;
  await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down");
});

test("config warnings show above the grid, and duplicates are listed under it", async ({ page }) => {
  const audit = (host: string) => ({ name: "audit", base_url: `https://${host}/__ashurbanipal`, healthy: true });
  await mockSiblings(page, {
    ...LABELLED,
    siblings: [
      ...LABELLED.siblings,
      { name: "billing", label: "dev", base_url: "https://billing-dev-2.example/__ashurbanipal", healthy: true },
      audit("audit-dev.example"),
      audit("audit-int.example"),
    ],
    warnings: [
      'two siblings share the name "billing" and the label "dev"',
      'two siblings share the name "audit" and no label',
    ],
  });
  await gotoApp(page);
  await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down · 2 warnings");
  await openMatrix(page);

  await expect(page.locator("#siblings-warnings .sibling-warning-text")).toHaveText([
    'Config: two siblings share the name "billing" and the label "dev"',
    'Config: two siblings share the name "audit" and no label',
  ]);
  await expect(cell(page, "billing", 0).locator("a")).toHaveAttribute("href", base("billing", "dev"));
  const rows = page.locator("#siblings-list .sibling-row");
  await expect(rows.locator(".sibling-name")).toHaveText(["billing", "audit", "audit"]);
  await expect(rows.locator(".sibling-note")).toHaveText(["dev · duplicate", "audit-dev.example", "audit-int.example"]);
  await expect(rows.nth(1)).toHaveAttribute("href", "https://audit-dev.example/__ashurbanipal");
});

test("warnings keep the pill visible when nothing else is listed", async ({ page }) => {
  const own = LABELLED.siblings[0];
  await mockSiblings(page, {
    instance: LABELLED.instance,
    siblings: [own, own],
    warnings: ['two siblings share the name "orders" and the label "dev"'],
  });
  await gotoApp(page);
  await expect(page.locator("#siblings")).toBeVisible();
  await page.locator("#siblings-btn").click();
  await expect(page.locator("#siblings-warnings")).toBeVisible();
});

test("a clean config shows no warnings", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page);
  await openMatrix(page);
  await expect(page.locator("#siblings-warnings")).toBeHidden();
  await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down");
});

test("a failed refresh keeps the last good list and label", async ({ page }) => {
  await page.clock.install();
  let fail = false;
  await page.route("**/api/siblings", (r) =>
    fail
      ? r.fulfill(problem(500, "boom", "database_error"))
      : r.fulfill({ contentType: "application/json", body: JSON.stringify(LABELLED) }),
  );
  await gotoApp(page, "?table=nosuchtable");
  await expect(page.locator("#view-notice-text")).toContainText("in dev");
  await openMatrix(page);

  fail = true;
  const failed = page.waitForResponse((r) => r.url().includes("/api/siblings") && !r.ok());
  await page.clock.runFor(15_000);
  await failed;
  await expect(page.locator("#siblings-matrix-body th[scope=row]")).toHaveCount(3);
  await expect(page.locator("#siblings")).toBeVisible();
  await expect(page.locator("#view-notice-text")).toContainText("in dev");
});

test("a refresh keeps focus on an unlabelled row under the grid", async ({ page }) => {
  await page.clock.install();
  let healthy = true;
  await page.route("**/api/siblings", (r) => {
    const body = structuredClone(LABELLED) as { instance: unknown; siblings: Record<string, unknown>[] };
    body.siblings.push({ name: "legacy", base_url: base("legacy", "x"), healthy });
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await gotoApp(page);
  await expect(page.locator("#siblings")).toBeVisible();
  await openMatrix(page);
  const row = page.locator("#siblings-list > a");
  await expect(row.locator(".sibling-name")).toHaveText("legacy");
  await row.focus();

  healthy = false;
  const polled = page.waitForResponse((r) => r.url().includes("/api/siblings"));
  await page.clock.runFor(15_000);
  await polled;
  await expect(row.locator(".sibling-state")).toHaveText("down");
  await expect(row).toBeFocused();
});

test("the grid does not inherit the data table's styles", async ({ page }) => {
  await mockSiblings(page, LABELLED);
  await gotoApp(page);
  await openMatrix(page);
  const style = (selector: string) =>
    page.locator(selector).first().evaluate((e) => {
      const s = getComputedStyle(e);
      return { cursor: s.cursor, userSelect: s.userSelect, position: s.position };
    });
  expect(await style("#data-table thead th[data-col]")).toMatchObject({ cursor: "pointer", userSelect: "none", position: "sticky" });
  expect(await style("#siblings-matrix thead th")).toMatchObject({ cursor: "auto", position: "static" });
  expect((await style("#siblings-matrix thead th")).userSelect).not.toBe("none");
});
