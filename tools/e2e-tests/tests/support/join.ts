import { expect, type Page, type Response } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./helpers";

export const ORDERS_USERS = "FROM orders o LEFT JOIN users u ON o.user_id = u.id";
/** ORDERS_USERS as the page prints it, and as it rides in `?join=`. */
export const ORDERS_USERS_CANONICAL = "SELECT *\nFROM orders o\nLEFT JOIN users u ON o.user_id = u.id";

export const joinRequest = (url: URL) => url.pathname.endsWith("/api/tables/join");

/** Resolves with the next /api/tables/join response; arm it before the action. */
export function nextJoinResponse(page: Page): Promise<Response> {
  return page.waitForResponse((r) => joinRequest(new URL(r.url())));
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

/** The query string of a join view, for gotoApp; `table` is the join's FROM table, as the app writes it. */
export function joinQuery(text: string, limit = 5): string {
  const table = /\bFROM\s+(\w+)/i.exec(text)?.[1] ?? "";
  return `?table=${table}&limit=${limit}&join=${encodeURIComponent(text)}`;
}

/** Loads the page straight into a join view through its URL. */
export async function gotoJoin(page: Page, text: string, limit = 5) {
  await gotoApp(page, joinQuery(text, limit));
}

/** A long table list collapses behind "+ N more", saved joins and `Save…` with it; open it. */
export async function expandTableChips(page: Page) {
  const more = page.locator("#tables-more");
  if (await more.isVisible()) {
    if ((await more.textContent())?.startsWith("+")) await more.click();
  }
}
