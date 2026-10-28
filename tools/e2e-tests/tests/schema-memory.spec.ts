import { test, expect, type Page } from "./support/fixtures";
import { spawnDemo, freePort } from "./support/second-server";
import { failRequests, goBack, gotoApp, reloadApp, urlParam, waitForIdle } from "./support/helpers";

// ui-guidelines R12: the schema selected on a source is remembered, so
// switching source away and back restores it instead of resetting to the
// source's default. Needs a multi-source demo (CONFORMANCE_SECOND_SOURCE adds an
// `other_schema` source); the shared seed already gives the `primary`
// source three schemas (public, other_schema, warehouse).

/** Picks an <option> and waits for the table-data refetch its onchange
 * kicks off to land, then for the view-transition to settle. `scopeParam`
 * (e.g. "schema=warehouse") pins the wait to *this* navigation's request,
 * not a stale in-flight one from the previous step. */
async function selectAndSettle(page: Page, selector: string, value: string, scopeParam: string) {
  const dataLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/tables/data") && r.url().includes(scopeParam) && r.ok(),
  );
  await page.locator(selector).selectOption(value);
  await dataLoaded;
  await waitForIdle(page);
}

test("schema is remembered per source across a source switch", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);

    // Both selectors render: two sources, and `primary` has three schemas.
    await expect(page.locator("#source-select-wrap")).toBeVisible();
    await expect(page.locator("#schema-select-wrap")).toBeVisible();
    await expect(page.locator("#schema-select")).toHaveValue("public");

    // Choose a non-default schema on `primary`, then bounce through the
    // other source and back.
    await selectAndSettle(page, "#schema-select", "warehouse", "schema=warehouse");
    await selectAndSettle(page, "#source-select", "other_schema", "source=other_schema");
    await selectAndSettle(page, "#source-select", "primary", "source=primary");

    // Restored, not reset to `public`.
    await expect(page.locator("#schema-select")).toHaveValue("warehouse");
    expect(await page.evaluate(() => {
      const raw = localStorage.getItem("ashurbanipal_view");
      return raw ? JSON.parse(raw).schemaBySource : null;
    })).toMatchObject({ primary: "warehouse" });
  } finally {
    await demo.stop();
  }
});

test("a source with no remembered schema opens the schema the server reports as its default", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);
    // The `other_schema` source's connection is pinned to other_schema, which it also lists first;
    // list public first so the first entry and the server's default differ.
    await page.route(
      (url) => url.pathname.endsWith("/api/schemas") && url.searchParams.get("source") === "other_schema",
      async (route) => {
        const body = await (await route.fetch()).json();
        body.schemas.sort((a: { name: string }, b: { name: string }) => (a.name === "public" ? -1 : b.name === "public" ? 1 : 0));
        await route.fulfill({ json: body });
      },
    );
    await selectAndSettle(page, "#source-select", "other_schema", "source=other_schema");
    await expect(page.locator("#schema-select")).toHaveValue("other_schema");
    expect(urlParam(page, "schema")).toBe("other_schema");
  } finally {
    await demo.stop();
  }
});

test("a fresh visit to a source opens the schema its connection is pinned to", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    // The first visit stores `primary` and `public`; `public` is listed on the other source too.
    await gotoApp(page, "", demo.baseUrl);
    await expect(page.locator("#schema-select")).toHaveValue("public");
    const tablesListed = page.waitForRequest(
      (r) => new URL(r.url()).pathname.endsWith("/api/tables") && new URL(r.url()).searchParams.get("source") === "other_schema",
    );
    await gotoApp(page, "?source=other_schema", demo.baseUrl);
    expect(new URL((await tablesListed).url()).searchParams.get("schema")).toBe("other_schema");
    await expect(page.locator("#schema-select")).toHaveValue("other_schema");
  } finally {
    await demo.stop();
  }
});

test("a source whose schema list fails is still named on every request", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);
    await failRequests(
      page,
      (url) => url.pathname.endsWith("/api/schemas") && url.searchParams.get("source") === "other_schema",
    );
    const tablesListed = page.waitForRequest(
      (r) => new URL(r.url()).pathname.endsWith("/api/tables") && new URL(r.url()).searchParams.get("source") === "other_schema",
    );
    await page.locator("#source-select").selectOption("other_schema");
    expect(new URL((await tablesListed).url()).searchParams.get("schema")).toBeNull();
    await waitForIdle(page);
    await expect(page.locator("#schema-select-wrap")).toBeHidden();
  } finally {
    await demo.stop();
  }
});

test("a malformed schemaBySource is discarded, not fatal", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);
    await page.evaluate(() =>
      localStorage.setItem("ashurbanipal_view", JSON.stringify({ schemaBySource: ["not", "an", "object"] })),
    );
    // Still boots and loads a table (R5).
    await reloadApp(page);
    await expect(page.locator("#tbody tr").first()).toBeVisible();
  } finally {
    await demo.stop();
  }
});

test("Back across a source switch restores that source's schema list", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);
    await selectAndSettle(page, "#schema-select", "warehouse", "schema=warehouse");
    // The second source lists other schemas, so the first source's list must come back with it.
    await page.route(
      (url) => url.pathname.endsWith("/api/schemas") && url.searchParams.get("source") === "other_schema",
      (route) => route.fulfill({ json: { schemas: [{ name: "other_schema" }, { name: "public" }], default: "other_schema" } }),
    );
    await selectAndSettle(page, "#source-select", "other_schema", "source=other_schema");
    await expect(page.locator('#schema-select option[value="warehouse"]')).toHaveCount(0);

    await goBack(page);
    await expect.poll(() => urlParam(page, "source")).toBe("primary");
    await waitForIdle(page);
    await expect(page.locator('#schema-select option[value="warehouse"]')).toHaveCount(1);
    await expect(page.locator("#schema-select")).toHaveValue("warehouse");
  } finally {
    await demo.stop();
  }
});

test("a superseded schema load does not reload the table list", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, conformanceSecondSource: true });
  try {
    await gotoApp(page, "", demo.baseUrl);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (url) => url.pathname.endsWith("/api/schemas") && url.searchParams.get("source") === "other_schema",
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );
    const schemasSent = page.waitForRequest((r) => new URL(r.url()).searchParams.get("source") === "other_schema");
    await page.locator("#source-select").selectOption("other_schema");
    await schemasSent;
    await selectAndSettle(page, "#source-select", "primary", "source=primary");

    const tableLists: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.endsWith("/api/tables")) tableLists.push(r.url());
    });
    const staleLanded = page.waitForResponse((r) => new URL(r.url()).searchParams.get("source") === "other_schema");
    release();
    await staleLanded;
    await waitForIdle(page);
    expect(tableLists).toEqual([]);
    expect(urlParam(page, "source")).toBe("primary");
  } finally {
    await demo.stop();
  }
});
