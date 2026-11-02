import { expect, type Locator, type Page, test } from "./support/fixtures";
import { dataWith, gotoApp, recordField, selectTable } from "./support/helpers";

// No seed value has edge whitespace or empty text, so the first rows carry them.
const DESCRIPTIONS = ["  Team mug, 350 ml ", "", "Bluetooth, 20 W\n", null];

async function openProducts(page: Page) {
  await page.route(dataWith("table", "products"), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    DESCRIPTIONS.forEach((d, i) => {
      body.rows[i].description = d;
    });
    await route.fulfill({ response, json: body });
  });
  await gotoApp(page);
  await selectTable(page, "products");
}

const cell = (page: Page, row: number) =>
  page.locator("#tbody tr").nth(row).locator('td[data-col="description"] .cell-text');
// toHaveText trims and collapses whitespace, so the exact text is read instead.
const exactText = (locator: Locator) => expect.poll(() => locator.evaluate((e) => e.textContent));

test("grid cells mark edge whitespace, empty text and null", async ({ page }) => {
  await openProducts(page);
  const padded = cell(page, 0).locator(".cell-ws");
  await expect(padded).toHaveCount(2);
  await expect(padded.first()).toHaveAttribute("title", "2 leading spaces");
  await expect(padded.last()).toHaveAttribute("title", "1 trailing space");
  await exactText(cell(page, 0)).toBe("  Team mug, 350 ml ");

  await expect(cell(page, 1).locator(".cell-empty")).toHaveText("''");
  await expect(cell(page, 1).locator(".cell-empty")).toHaveAttribute("title", "empty text");

  // The ↵ is drawn by CSS, so the text has no newline in it.
  await expect(cell(page, 2).locator(".cell-nl")).toHaveAttribute("title", "trailing newline");
  await exactText(cell(page, 2)).toBe("Bluetooth, 20 W");

  await expect(cell(page, 3)).toHaveClass(/cell-null/);
  await expect(cell(page, 3)).toHaveAttribute("title", "null");
});

test("the record view marks them the same way", async ({ page }) => {
  await openProducts(page);
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  const description = recordField(page, "description");
  await expect(description.dd.locator(".cell-ws")).toHaveCount(2);
  await page.locator("#record-next").click();
  await expect(description.dd.locator(".cell-empty")).toHaveText("''");
  await page.locator("#record-next").click();
  await expect(description.dd.locator(".cell-nl")).toHaveCount(1);
  await page.locator("#record-next").click();
  await expect(description.dd.locator(".cell-null")).toHaveAttribute("title", "null");
});
