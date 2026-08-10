import { test, expect } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";

test("back/forward buttons step through table navigation history", async ({ page }) => {
  await gotoApp(page);
  // The auto-loaded initial view is the baseline, not a pushed entry — no
  // navigation has happened yet, so both directions start disabled
  // regardless of which table happens to load first.
  await expect(page.locator("#nav-back")).toBeDisabled();
  await expect(page.locator("#nav-forward")).toBeDisabled();

  await selectTable(page, "users");
  await expect(page.locator("#nav-back")).toBeEnabled();
  await expect(page.locator("#nav-forward")).toBeDisabled();

  await selectTable(page, "orders");
  await selectTable(page, "products");

  await page.locator("#nav-back").click();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#nav-forward")).toBeEnabled();

  await page.locator("#nav-back").click();
  await page.locator("#current").getByText("users", { exact: true }).waitFor();

  await page.locator("#nav-back").click();
  await expect(page.locator("#nav-back")).toBeDisabled();

  await page.locator("#nav-forward").click();
  await page.locator("#current").getByText("users", { exact: true }).waitFor();
  await page.locator("#nav-forward").click();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await page.locator("#nav-forward").click();
  await page.locator("#current").getByText("products", { exact: true }).waitFor();
  await expect(page.locator("#nav-forward")).toBeDisabled();
});

test("navigating to a different table from a back-stepped position truncates the forward stack", async ({
  page,
}) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await selectTable(page, "orders");
  await selectTable(page, "products");

  await page.locator("#nav-back").click();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();

  // Diverging here should discard the stale "products" forward entry.
  await selectTable(page, "sessions");
  await expect(page.locator("#nav-forward")).toBeDisabled();

  await page.locator("#nav-back").click();
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await page.locator("#nav-forward").click();
  await page.locator("#current").getByText("sessions", { exact: true }).waitFor();
});

test("sorting within the initially-loaded table does not create a back-stop", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("#nav-back")).toBeDisabled();
  // Whatever table auto-loaded first — sorting it is a same-table
  // refinement, not a navigation, so it must not enable "back".
  await page.locator("thead th[data-col]").first().click();
  await waitForIdle(page);
  await expect(page.locator("#nav-back")).toBeDisabled();
});
