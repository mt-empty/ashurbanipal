import { expect, type Page } from "@playwright/test";
import { APP_PATH, apiCall, gotoApp, selectTable, waitForIdle } from "./helpers";
import { gotoJoin, ORDERS_USERS } from "./join";

const API = `${APP_PATH}/api`;

// Routes that take no scope, or only a source; every other API request must name both.
const UNSCOPED = new Set(["/sources", "/siblings"]);
const SOURCE_ONLY = new Set(["/schemas"]);

const SCOPED_ROUTES = [
  "/tables",
  "/table-counts",
  "/tables/data",
  "/tables/common-values",
  "/tables/structure",
  "/tables/referenced-by",
  "/tables/join",
];

// What start-up may send before /sources has answered (frontend/src/bootstrap/boot-prefetch.ts).
const START_UP_ROUTES = ["/sources", "/schemas", "/tables", "/table-counts", "/tables/data"];

/** An API request, and whether start-up sent it ahead, before /sources had answered. */
export interface SeenRequest {
  url: URL;
  early: boolean;
}

/** Opens the app and drives it through every scoped API route, returning each API request the page made. */
export async function exerciseEveryRoute(page: Page): Promise<SeenRequest[]> {
  const seen: SeenRequest[] = [];
  let sourcesAnswered = false;
  page.on("response", (r) => {
    if (apiCall("/sources")(r.url())) sourcesAnswered = true;
  });
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith(`${API}/`)) seen.push({ url, early: !sourcesAnswered });
  });

  await gotoApp(page);
  await selectTable(page, "orders");
  await page.locator('th[data-col="status"]').click({ position: { x: 6, y: 6 } });
  await waitForIdle(page);
  // SQLite and MySQL always answer common-values with an empty list, so wait on the response, not on a value.
  const commonValues = page.waitForResponse(apiCall("/tables/common-values"));
  await page.locator('.common-values-btn[aria-label="common values for status"]').click();
  await commonValues;
  await page.keyboard.press("Escape");
  const structure = page.waitForResponse(apiCall("/tables/structure"));
  await page.locator("#structure-btn").click();
  await structure;
  await expect(page.locator("#structure-body")).toContainText("user_id");
  await page.keyboard.press("Escape");
  await page.locator("#tbody tr").first().locator(".record-btn").click();
  await expect(page.locator("#record-referenced-by")).not.toContainText("loading…");
  await page.keyboard.press("Escape");
  await gotoJoin(page, ORDERS_USERS);
  return seen;
}

/** Every scoped route was hit, and each request named `source` and `schema` rather than leaning on server
 * defaults — except start-up's early ones, sent before the scope is known; the page uses such an answer
 * only when it matches the scope start-up settles on. */
export function expectScoped(seen: SeenRequest[], source: string, schema: string) {
  const routes = new Set(seen.map(({ url }) => url.pathname.slice(API.length)));
  for (const route of SCOPED_ROUTES) expect(routes, `no ${route} request was made`).toContain(route);
  for (const { url, early } of seen) {
    const route = url.pathname.slice(API.length);
    if (early && !UNSCOPED.has(route)) {
      expect(START_UP_ROUTES, `start-up sent ${route} early`).toContain(route);
      continue;
    }
    const scope = { source: url.searchParams.get("source"), schema: url.searchParams.get("schema") };
    if (UNSCOPED.has(route)) expect(scope, route).toEqual({ source: null, schema: null });
    else if (SOURCE_ONLY.has(route)) expect(scope, route).toEqual({ source, schema: null });
    else expect(scope, `${route}${url.search}`).toEqual({ source, schema });
  }
}
