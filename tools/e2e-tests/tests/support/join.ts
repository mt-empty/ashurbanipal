import { expect, type Page, type Response } from "@playwright/test";
import { gotoApp, selectTable, waitForIdle } from "./helpers";

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
  await page.locator("#join-mode-sql").check();
  await page.locator("#join-sql").fill(text);
}

/** Runs the join from the overlay and waits for the grid to settle. */
export async function showResult(page: Page): Promise<Response> {
  const response = nextJoinResponse(page);
  await page.locator("#join-run").click();
  const r = await response;
  await waitForIdle(page);
  return r;
}

/** Loads the page straight into a join view through its URL. */
export async function gotoJoin(page: Page, text: string, limit = 5) {
  const response = nextJoinResponse(page);
  await page.goto(`/__ashurbanipal?table=orders&limit=${limit}&join=${encodeURIComponent(text)}`);
  await response;
  await waitForIdle(page);
}
