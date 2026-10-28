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

/** Opens the app and drives it through every scoped API route, returning each API request the page made. */
export async function exerciseEveryRoute(page: Page): Promise<URL[]> {
  const seen: URL[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith(`${API}/`)) seen.push(url);
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

/** Every scoped route was hit, and each request named `source` and `schema` rather than leaning on server defaults. */
export function expectScoped(seen: URL[], source: string, schema: string) {
  const routes = new Set(seen.map((u) => u.pathname.slice(API.length)));
  for (const route of SCOPED_ROUTES) expect(routes, `no ${route} request was made`).toContain(route);
  for (const url of seen) {
    const route = url.pathname.slice(API.length);
    const scope = { source: url.searchParams.get("source"), schema: url.searchParams.get("schema") };
    if (UNSCOPED.has(route)) expect(scope, route).toEqual({ source: null, schema: null });
    else if (SOURCE_ONLY.has(route)) expect(scope, route).toEqual({ source, schema: null });
    else expect(scope, `${route}${url.search}`).toEqual({ source, schema });
  }
}
