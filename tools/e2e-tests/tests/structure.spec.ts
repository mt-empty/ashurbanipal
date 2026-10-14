import { test, expect, type Route } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

// Seed shape (conformance/seed): orders has the partial index
// orders_pending_idx and orders.user_id ON DELETE CASCADE; inventory_counts
// has the composite FK (warehouse_code, bin_code) -> inventory_locations.

const STRUCTURE = "**/api/tables/structure*";

async function openStructure(page: import("@playwright/test").Page) {
  const response = page.waitForResponse((r) => r.url().includes("/api/tables/structure"));
  await page.locator("#structure-btn").click();
  await response;
}

test("structure shows a partial index and a non-default FK action", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await openStructure(page);

  const body = page.locator("#structure-body");
  await expect(page.locator("#structure-dialog")).toBeVisible();
  await expect(page.locator("#structure-title")).toHaveText("structure — public.orders");
  await expect(body.getByText("orders_pending_idx")).toBeVisible();
  await expect(body.getByText(/WHERE .*pending/)).toBeVisible();
  await expect(body.getByText("ON DELETE CASCADE")).toBeVisible();
});

test("structure shows a composite FK as one entry with both column pairs", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "inventory_counts");
  await openStructure(page);

  await expect(
    page.locator("#structure-body").getByText("warehouse_code, bin_code → inventory_locations(warehouse_code, bin_code)"),
  ).toBeVisible();
});

test("a failed structure fetch is reported inside the dialog and leaves the grid and banner alone", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.route(STRUCTURE, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "catalog unavailable", status: 500, code: "database_error" }),
    }),
  );
  await openStructure(page);

  await expect(page.locator("#structure-body")).toContainText("catalog unavailable");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("structure is cached per table: reopening is free, another table fetches again", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "orders");
  let requests = 0;
  await page.route(STRUCTURE, (route) => {
    requests++;
    return route.continue();
  });

  await openStructure(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#structure-dialog")).toBeHidden();
  await page.locator("#structure-btn").click();
  await expect(page.locator("#structure-body").getByText("orders_pending_idx")).toBeVisible();
  expect(requests).toBe(1);

  await page.keyboard.press("Escape");
  await selectTable(page, "users");
  await openStructure(page);
  expect(requests).toBe(2);
});

test("a slow response for a previous table never overwrites the current table's structure", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");

  let held: Route | undefined;
  await page.route(STRUCTURE, (route) => {
    if (new URL(route.request().url()).searchParams.get("table") === "users") {
      held = route;
      return;
    }
    return route.continue();
  });

  await page.locator("#structure-btn").click();
  await expect.poll(() => held !== undefined).toBe(true);
  await expect(page.locator("#structure-body")).toContainText("loading…");
  await page.keyboard.press("Escape");

  await selectTable(page, "orders");
  await openStructure(page);
  await expect(page.locator("#structure-body").getByText("orders_pending_idx")).toBeVisible();

  await held?.continue();
  await waitForIdle(page);
  await expect(page.locator("#structure-title")).toHaveText("structure — public.orders");
  await expect(page.locator("#structure-body").getByText("orders_pending_idx")).toBeVisible();
});
