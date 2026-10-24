import { test, expect, type Page } from "./support/fixtures";
import { gotoApp, selectTable, waitForIdle } from "./support/helpers";
import { spawnDemo, freePort } from "./support/second-server";

// A name the page URL asked for that this instance lacks falls back as before
// (R5), and now says so in #view-notice. A name restored from localStorage
// still resets silently (ui-guidelines R6d).

const note = (page: Page) => page.locator("#view-notice");

test("a missing table and its filter are both named in the note", async ({ page }) => {
  await gotoApp(page, "?table=nosuchtable&filter=" + encodeURIComponent("status = completed"));
  const shown = (await page.locator("#current").textContent()) ?? "";
  // The filter was written against the missing table's columns, so it must not ride along.
  await expect(page.locator("#filter")).toHaveValue("");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
  await expect(note(page)).toBeVisible();
  await expect(page.locator("#view-notice-text")).toHaveText(
    `There is no table nosuchtable here. Showing ${shown} instead, without your filter.`,
  );
  await expect(page.locator("#view-notice-text code")).toHaveText(["nosuchtable", shown]);
});

test("a missing schema falls back to public and says so", async ({ page }) => {
  await gotoApp(page, "?schema=nosuch&table=orders");
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#view-notice-text")).toHaveText("There is no schema nosuch here. Showing public instead.");
});

test("a URL filter naming a missing column is removed with a note", async ({ page }) => {
  await gotoApp(page, "?table=orders&filter=" + encodeURIComponent("nosuchcol = 1"));
  await page.locator("#current").getByText("orders", { exact: true }).waitFor();
  await expect(page.locator("#filter")).toHaveValue("");
  await expect(page.locator("#view-notice-text")).toHaveText("Your filter doesn't fit orders here, so it was removed.");
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#tbody tr").first()).toBeVisible();
});

test("a stale table restored from localStorage resets without a note", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ashurbanipal_ui", JSON.stringify({ table: "nosuchtable" }));
  });
  await gotoApp(page);
  await expect(page.locator("#current")).not.toHaveText("—");
  await expect(note(page)).toBeHidden();
});

test("the close button hides the note", async ({ page }) => {
  await gotoApp(page, "?table=nosuchtable");
  await expect(note(page)).toBeVisible();
  await page.getByRole("button", { name: "Close this note" }).click();
  await expect(note(page)).toBeHidden();
});

test("a refresh keeps the note and a table switch hides it", async ({ page }) => {
  await gotoApp(page, "?table=nosuchtable");
  await expect(note(page)).toBeVisible();

  const refreshed = page.waitForResponse((r) => r.url().includes("/api/tables/data"));
  await page.locator("#refresh").click();
  await refreshed;
  await waitForIdle(page);
  await expect(note(page)).toBeVisible();

  await selectTable(page, "products");
  await expect(note(page)).toBeHidden();
});

test("a missing source falls back to the first source and says so", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "?source=nosuch", demo.baseUrl);
    await expect(page.locator("#view-notice-text")).toHaveText("There is no source nosuch here. Showing primary instead.");
  } finally {
    await demo.stop();
  }
});

test("switching to a schema with no tables hides the note", async ({ page }) => {
  await page.route("**/api/tables*", (route) => {
    const schema = new URL(route.request().url()).searchParams.get("schema");
    if (schema === "warehouse") return route.fulfill({ json: { tables: [] } });
    return route.continue();
  });
  await gotoApp(page, "?table=nosuchtable");
  await expect(note(page)).toBeVisible();
  const listed = page.waitForResponse((r) => r.url().includes("/api/tables?") && r.url().includes("schema=warehouse"));
  await page.locator("#schema-select").selectOption("warehouse");
  await listed;
  await expect(note(page)).toBeHidden();
});
