import { expect, type Page, test } from "./support/fixtures";
import {
  applyFilter,
  gotoApp,
  problem,
  recordField,
  recordRequests,
  selectTable,
  tableData,
  urlParam,
  waitForIdle,
} from "./support/helpers";

// Seed facts (tools/seed-gen): public.users has 50 rows whose metadata holds
// role (50: user 23, admin 11, moderator 10, support 6), prefs (29: theme dark
// 11, light 18) and beta_features (16); events.payload->n runs 0 to 399.

const rows = (page: Page) => page.locator("#tbody tr:not(.empty)");
const suggestions = (page: Page) => page.locator("#filter-suggest-list button");
const labels = (page: Page) => page.locator("#filter-suggest-list .sg-label");
const notes = (page: Page) => page.locator("#filter-suggest-list .sg-note");
const heading = (page: Page) => page.locator("#filter-suggest-heading");

test("a path filter sends the path, keeps it in the URL, and marks the matched member", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const sent = page.waitForRequest(tableData);
  await applyFilter(page, "metadata->prefs->theme = dark");
  const filter = new URL((await sent).url()).searchParams.get("filter");
  expect(JSON.parse(filter ?? "")).toEqual([{ column: "metadata", path: ["prefs", "theme"], op: "=", value: "dark" }]);
  await expect(rows(page)).toHaveCount(11);
  expect(urlParam(page, "filter")).toBe("metadata->prefs->theme = dark");
  const marks = page.locator('#tbody td[data-col="metadata"] mark.json-match');
  await expect(marks).toHaveCount(11);
  await expect(marks.first()).toHaveText('"theme": "dark"');
  await expect(page.locator("#filter-hl .t-key")).toHaveText(["prefs", "theme"]);
  await expect(page.locator("#filter-hl .t-arrow")).toHaveText(["->", "->"]);
});

test("IS NULL on a path matches the rows without the key", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->prefs IS NULL");
  await expect(rows(page)).toHaveCount(21);
});

test("after -> the keys of the loaded rows are suggested, and an object key opens the next level", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await page.locator("#filter").fill("metadata->");
  await expect(heading(page)).toHaveText("keys in 50 loaded rows");
  await expect(labels(page)).toHaveText(["role", "prefs", "beta_features"]);
  await expect(notes(page)).toHaveText(["text · 50", "object · 29", "array · 16"]);
  await labels(page)
    .filter({ hasText: /^prefs$/ })
    .click();
  await expect(page.locator("#filter")).toHaveValue("metadata->prefs->");
  await expect(heading(page)).toHaveText("keys under prefs");
  await expect(labels(page)).toHaveText(["theme"]);
  await page.locator("#filter").press("Tab");
  await expect(page.locator("#filter")).toHaveValue("metadata->prefs->theme ");
  await expect(suggestions(page).first()).toHaveText("=");
});

test("an array's indexes are suggested after its arrow", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await page.locator("#filter").fill("metadata->beta_features->");
  await expect(heading(page)).toHaveText("beta_features is an array");
  await expect(labels(page).first()).toHaveText("0");
  await expect(notes(page).first()).toHaveText("16 rows");
});

test("values after a path's operator come from the loaded rows", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const commonValues = recordRequests(page, (r) => r.url().includes("/tables/common-values"));
  await page.locator("#filter").fill("metadata->role = ");
  await expect(heading(page)).toHaveText("values in 50 loaded rows");
  await expect(labels(page)).toHaveText(["user", "admin", "moderator", "support"]);
  await expect(notes(page)).toHaveText(["23", "11", "10", "6"]);
  expect(commonValues).toEqual([]);
});

test("a path on a column that isn't JSON is stopped before sending", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  const sent = recordRequests(page, (r) => tableData(r));
  await page.locator("#filter").fill("email->domain = example.net");
  await expect(page.locator("#filter-hl .t-err")).toHaveText(["->", "domain"]);
  await page.locator("#filter").press("Enter");
  await expect(page.locator("#error")).toHaveText("email is text. Only json and jsonb columns take a path (->).");
  expect(sent).toEqual([]);
});

test("spaces inside a path are underlined and explained", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await page.locator("#filter").fill("metadata -> role = admin");
  await expect(page.locator("#filter-hl .t-err")).toHaveText("->");
  await page.locator("#filter").press("Enter");
  await expect(page.locator("#error")).toHaveText(/remove the spaces around ->: write metadata->role/);
});

test("the record view's tree filters by a leaf, and the JSON field itself has no =", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->prefs IS NOT NULL");
  await rows(page).first().locator(".record-btn").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  const metadata = recordField(page, "metadata");
  await expect(metadata.eq).toHaveCount(0);
  await expect(metadata.copy).toHaveCount(1);
  // Containers get no actions; only leaves do.
  await expect(metadata.dd.locator(".json-node > .json-line .json-acts")).toHaveCount(0);
  const theme = metadata.dd.locator(".json-line", { hasText: '"theme"' });
  const eq = theme.locator(".filter-eq");
  await expect(eq).toHaveAttribute("title", /^metadata->prefs->theme = (dark|light)$/);
  const clause = await eq.getAttribute("title");
  await theme.hover();
  await eq.click();
  await waitForIdle(page);
  await expect(page.locator("#record-dialog")).toBeHidden();
  await expect(page.locator("#filter")).toHaveValue(clause ?? "");
  await expect(rows(page)).toHaveCount(clause?.endsWith("dark") ? 11 : 18);
});

test("an array item in the tree filters by its index", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->beta_features IS NOT NULL");
  await rows(page).first().locator(".record-btn").click();
  const tree = recordField(page, "metadata").dd;
  await expect(tree.locator('.filter-eq[title^="metadata->beta_features->0 = "]')).toHaveCount(1);
});

test("the cell popup's tree filters by a leaf too", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->prefs IS NOT NULL");
  await rows(page).first().locator('td[data-col="metadata"] .cell-text').click();
  await expect(page.locator("#cell-pop")).toBeVisible();
  const role = page.locator("#cell-json .json-line", { hasText: '"role"' });
  const eq = role.locator(".filter-eq");
  await expect(eq).toHaveAttribute("title", /^metadata->role = \w+$/);
  const clause = await eq.getAttribute("title");
  await role.hover();
  await eq.click();
  await waitForIdle(page);
  await expect(page.locator("#cell-pop")).toBeHidden();
  await expect(page.locator("#filter")).toHaveValue(clause ?? "");
});

test("an order comparison against a number on a path says it compares as text", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "events");
  await applyFilter(page, "payload->n > 9");
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator("#view-notice-text")).toHaveText("payload->n is compared as text, so 10 comes before 9.");
  await applyFilter(page, "payload->n = 9");
  await expect(page.locator("#view-notice")).toBeHidden();
});

test("an empty result names a value that differs only by case and points to ILIKE", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->role = Admin");
  await expect(page.locator("#tbody tr.empty td")).toHaveText(
    "No rows match. Text inside JSON is matched exactly, so Admin is not admin. The loaded rows have role = admin. Use ILIKE to ignore case.",
  );
});

test("a server from before paths gets a message that says so", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await page.route(
    (url) => tableData(url) && (url.searchParams.get("filter") ?? "").includes('"path"'),
    (route) => route.fulfill(problem(400, 'condition 0 has unknown field "path"', "invalid_filter")),
  );
  await applyFilter(page, "metadata->role = admin");
  await expect(page.locator("#error")).toHaveText(
    "This server doesn't support JSON paths yet. Update ashurbanipal on the host to use them.",
  );
});

test("a dismissed text-comparison notice stays dismissed when the rows are sorted", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "events");
  await applyFilter(page, "payload->n > 9");
  await expect(page.locator("#view-notice")).toBeVisible();
  await page.locator("#view-notice-close").click();
  await page.locator('th[data-col="id"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  await expect(page.locator("#view-notice")).toBeHidden();
});

test("a JSON value that isn't an object or array keeps the field's own =", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "json_docs");
  // Row 6's doc is the JSON string "not json"; row 1's is an object.
  await applyFilter(page, "id = 6");
  await rows(page).first().locator(".record-btn").click();
  const doc = recordField(page, "doc");
  await expect(doc.eq).toHaveCount(1);
  await expect(doc.dd.locator(".json-acts")).toHaveCount(0);
  await page.locator('#record-dialog button[aria-label="close"]').click();
  await expect(page.locator("#record-dialog")).toBeHidden();
  await applyFilter(page, "id = 1");
  await rows(page).first().locator(".record-btn").click();
  await expect(recordField(page, "doc").eq).toHaveCount(0);
  await page.locator('#record-dialog button[aria-label="close"]').click();
  // Row 4's doc is {}: no leaves, so the field keeps its =.
  await applyFilter(page, "id = 4");
  await rows(page).first().locator(".record-btn").click();
  await expect(recordField(page, "doc").eq).toHaveCount(1);
});

test("nested matches mark only the outer member, and the cell text stays whole", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "json_docs");
  await applyFilter(page, "doc->arr IS NOT NULL AND doc->arr->0 IS NOT NULL AND doc->arr->0->'user id' = 42");
  const cell = rows(page).first().locator('td[data-col="doc"] .cell-text');
  await expect(cell.locator("mark.json-match")).toHaveCount(1);
  await expect(cell.locator("mark.json-match")).toHaveText(/^"arr": \[/);
  const shown = await cell.textContent();
  expect(JSON.parse(shown ?? "")).toHaveProperty("status", "failed");
});

test("under OR, a condition the page can't check marks nothing", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "json_docs");
  await applyFilter(page, "doc->status LIKE 'f%' OR id = 2");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#tbody mark.json-match")).toHaveCount(0);
});

test("the cell popup and record view mark the member the path filter matched", async ({ page }) => {
  await gotoApp(page);
  await selectTable(page, "users");
  await applyFilter(page, "metadata->prefs->theme = dark");
  await rows(page).first().locator('td[data-col="metadata"] .cell-text').click();
  await expect(page.locator("#cell-pop")).toBeVisible();
  await expect(page.locator("#cell-json .json-match")).toHaveCount(1);
  await expect(page.locator("#cell-json .json-line.json-match")).toHaveText(/^"theme":\s*"dark"/);
  await page.locator("#current").click();
  await expect(page.locator("#cell-pop")).toBeHidden();
  // An object member is marked as a whole block.
  await applyFilter(page, "metadata->prefs IS NOT NULL");
  await rows(page).first().locator(".record-btn").click();
  const marked = recordField(page, "metadata").dd.locator(".json-match");
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveClass(/json-node/);
  await expect(marked.locator(".json-key").first()).toHaveText('"prefs"');
});
