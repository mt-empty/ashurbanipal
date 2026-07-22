import { test, expect } from "@playwright/test";
import { spawnDemo, freePort } from "./support/second-server";

// Mount-point agnosticism: the frontend derives its API base from
// location.pathname, so the whole UI must keep working when the router is
// nested under a proxy-style prefix (demo's MOUNT_PREFIX). Like
// siblings.spec.ts, this needs its own demo instance rather than the
// config's default webServer.

test("UI loads tables and data when mounted under a path prefix", async ({ page }) => {
  const port = await freePort();
  const demo = await spawnDemo({ port, mountPrefix: "/svc" });
  try {
    const dataLoaded = page.waitForResponse(
      (r) => r.url().includes("/svc/__ashurbanipal/api/tables/data") && r.ok(),
    );
    await page.goto(`${demo.baseUrl}/svc/__ashurbanipal`);
    await expect(page.locator("#tables button").first()).toBeVisible();
    await dataLoaded;
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  } finally {
    await demo.stop();
  }
});
