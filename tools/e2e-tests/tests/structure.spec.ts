import { expect, type Route, test } from "./support/fixtures";
import { gotoApp, problem, selectTable, waitForIdle } from "./support/helpers";

// Seed shape (conformance/seed): orders has the partial index
// orders_pending_idx and orders.user_id ON DELETE CASCADE; inventory_counts
// has the composite FK (warehouse_code, bin_code) -> inventory_locations.

const STRUCTURE = "**/api/tables/structure*";

// The grid asks for the structure when a table opens, so the dialog usually finds it cached.
async function openStructure(page: import("@playwright/test").Page) {
  await page.locator("#structure-btn").click();
  await expect(page.locator("#structure-body")).not.toContainText("loading…");
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
    page
      .locator("#structure-body")
      .getByText("warehouse_code, bin_code → inventory_locations(warehouse_code, bin_code)"),
  ).toBeVisible();
});

test("a failed structure fetch is reported inside the dialog and leaves the grid and banner alone", async ({
  page,
}) => {
  await page.route(STRUCTURE, (route) => route.fulfill(problem(500, "catalog unavailable", "database_error")));
  await gotoApp(page);
  await selectTable(page, "orders");
  await openStructure(page);

  await expect(page.locator("#structure-body")).toContainText("catalog unavailable");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("structure is cached per table: opening and reopening are free, another table fetches again", async ({ page }) => {
  const requests = new Map<string, number>();
  const asked = (table: string) => requests.get(table) ?? 0;
  await page.route(STRUCTURE, (route) => {
    const table = new URL(route.request().url()).searchParams.get("table") ?? "";
    requests.set(table, asked(table) + 1);
    return route.continue();
  });
  await gotoApp(page);
  await selectTable(page, "orders");
  // The grid asks once when the table opens.
  await expect.poll(() => asked("orders")).toBe(1);

  await openStructure(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#structure-dialog")).toBeHidden();
  await page.locator("#structure-btn").click();
  await expect(page.locator("#structure-body").getByText("orders_pending_idx")).toBeVisible();
  expect(asked("orders")).toBe(1);

  await page.keyboard.press("Escape");
  await selectTable(page, "products");
  await openStructure(page);
  await expect(page.locator("#structure-title")).toHaveText("structure — public.products");
  expect(asked("products")).toBe(1);
});

test("a slow response for a previous table never overwrites the current table's structure", async ({ page }) => {
  let held: Route | undefined;
  await page.route(STRUCTURE, (route) => {
    if (new URL(route.request().url()).searchParams.get("table") === "users") {
      held = route;
      return;
    }
    return route.continue();
  });
  await gotoApp(page);
  await selectTable(page, "users");

  // The dialog shares the grid's request, still held.
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
