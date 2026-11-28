import { expect, type Page, test } from "./support/fixtures";
import { dataWith, gotoApp, selectTable, waitForIdle } from "./support/helpers";

// No seed column has a space in its name, so products' `name` is served as `product name`,
// and a filter on `product name` is sent to the server as one on `name`.
const SHOWN = "product name";

async function openProducts(page: Page): Promise<unknown[]> {
  const filtersSent: unknown[] = [];
  await page.route(dataWith("table", "products"), async (route) => {
    const url = new URL(route.request().url());
    const filter = url.searchParams.get("filter");
    if (filter) {
      const ast: { column: string }[] = JSON.parse(filter);
      filtersSent.push(ast);
      url.searchParams.set(
        "filter",
        JSON.stringify(ast.map((c) => (c.column === SHOWN ? { ...c, column: "name" } : c))),
      );
    }
    const response = await route.fetch({ url: url.toString() });
    const body = await response.json();
    for (const col of body.columns) if (col.name === "name") col.name = SHOWN;
    for (const row of body.rows) {
      row[SHOWN] = row.name;
      delete row.name;
    }
    await route.fulfill({ response, json: body });
  });
  await gotoApp(page);
  await selectTable(page, "products");
  return filtersSent;
}

test("the = button double-quotes a column name with a space, and the filter applies", async ({ page }) => {
  const sent = await openProducts(page);
  const cell = page.locator("#tbody tr").first().locator(`td[data-col="${SHOWN}"]`);
  const value = (await cell.locator(".cell-text").textContent()) ?? "";
  await cell.hover();
  await cell.locator(".filter-eq").click();
  await waitForIdle(page);

  await expect(page.locator("#filter")).toHaveValue(new RegExp(`^"${SHOWN}" = `));
  await expect(page.locator("#error")).toBeEmpty();
  expect(sent.at(-1)).toEqual([{ column: SHOWN, op: "=", value }]);
  const shown = page.locator(`#tbody td[data-col="${SHOWN}"] .cell-text`);
  await expect.poll(async () => (await shown.allTextContents()).every((v) => v === value)).toBe(true);
});

test("a typed quoted column filters, and the box colours it as a column", async ({ page }) => {
  const sent = await openProducts(page);
  const filter = page.locator("#filter");
  await filter.fill(`"${SHOWN}" LIKE 'T%'`);
  await expect(page.locator("#filter-hl-text .t-column")).toHaveText(`"${SHOWN}"`);
  await filter.press("Enter");
  await waitForIdle(page);

  await expect(page.locator("#error")).toBeEmpty();
  expect(sent.at(-1)).toEqual([{ column: SHOWN, op: "LIKE", value: "T%" }]);
});
