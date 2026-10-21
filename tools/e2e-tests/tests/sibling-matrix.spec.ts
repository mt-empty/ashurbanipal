import { test, expect, type Page } from "@playwright/test";
import { APP_PATH, gotoApp, selectTable } from "./support/helpers";

// The service × label grid in Other services (story 03 §4.3). /api/siblings is
// mocked: the shape is what matters here, and spec/protocol.md §5.6's server
// side is covered by conformance/runner/labelled_siblings.rs.

const base = (name: string, label: string) => `https://${name}-${label}.example/__ashurbanipal`;

const LABELLED = {
  instance: { name: "orders", label: "dev" },
  siblings: [
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

test("rows and columns put this instance first", async ({ page }) => {
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
    body.siblings[1].healthy = healthy;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(APP_PATH);
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
  await page.goto(APP_PATH);
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
      ? r.fulfill({ status: 500, contentType: "application/problem+json", body: '{"title":"boom","status":500}' })
      : r.fulfill({ contentType: "application/json", body: JSON.stringify(LABELLED) }),
  );
  const failed = page.waitForResponse((r) => r.url().includes("/api/siblings"));
  await page.goto(APP_PATH);
  await failed;
  await expect(page.locator("#siblings")).toBeHidden();

  fail = false;
  const retried = page.waitForResponse((r) => r.url().includes("/api/siblings") && r.ok());
  await page.clock.runFor(15_000);
  await retried;
  await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down");
});

test("a failed refresh keeps the last good list and label", async ({ page }) => {
  await page.clock.install();
  let fail = false;
  await page.route("**/api/siblings", (r) =>
    fail
      ? r.fulfill({ status: 500, contentType: "application/problem+json", body: '{"title":"boom","status":500}' })
      : r.fulfill({ contentType: "application/json", body: JSON.stringify(LABELLED) }),
  );
  await page.goto(`${APP_PATH}?table=nosuchtable`);
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
