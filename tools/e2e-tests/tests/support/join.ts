import { expect, type Page, type Response } from "@playwright/test";
import { APP_PATH, gotoApp, selectTable, waitForIdle } from "./helpers";

export const ORDERS_USERS = "FROM orders o LEFT JOIN users u ON o.user_id = u.id";

/** Resolves with the next /api/tables/join response; arm it before the action. */
export function nextJoinResponse(page: Page): Promise<Response> {
  return page.waitForResponse((r) => r.url().includes("/api/tables/join"));
}

/** The decoded `join` query parameter of a request URL. */
export function joinParam(url: string): unknown {
  return JSON.parse(new URL(url).searchParams.get("join") as string);
}

/** Opens the app on `orders` and the join overlay from the `⋈ join` button. */
export async function openJoinOverlay(page: Page) {
  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator("#join-btn").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
}

/** Switches the open overlay to SQL mode and types `text` into it. */
export async function writeSql(page: Page, text: string) {
  await page.locator("#join-mode-sql").click();
  await page.locator("#join-sql").fill(text);
}

/** Opens the dropdown named by `label` in the form and picks the row with `value`. */
export async function pick(page: Page, label: string, value: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.locator(`#dd-pop .dd-row[data-value="${value}"]`).click();
}

/** Runs the join from the overlay and waits for the grid to settle. */
export async function showResult(page: Page): Promise<Response> {
  const response = nextJoinResponse(page);
  await page.locator("#join-run").click();
  const r = await response;
  await waitForIdle(page);
  return r;
}

/** The app URL of a join view starting from `orders`. */
export function joinUrl(text: string, limit = 5): string {
  return `${APP_PATH}?table=orders&limit=${limit}&join=${encodeURIComponent(text)}`;
}

/** Loads the page straight into a join view through its URL. */
export async function gotoJoin(page: Page, text: string, limit = 5) {
  const response = nextJoinResponse(page);
  await page.goto(joinUrl(text, limit));
  await response;
  await waitForIdle(page);
}

/** A long table list collapses behind "+ N more", saved joins and `Save…` with it; open it. */
export async function expandTableChips(page: Page) {
  const more = page.locator("#tables-more");
  if (await more.isVisible()) {
    if ((await more.textContent())?.startsWith("+")) await more.click();
  }
}
