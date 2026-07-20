import { test, expect } from "@playwright/test";
import { spawnDemo, freePort } from "./support/second-server";

// The one spec that doesn't share the config's default webServer — sibling
// health-polling needs a second live instance, so this spawns its own pair
// directly (mirroring `mise run demo-sibling`'s PORT/SIBLING_PORT), per the
// design doc §3.

test("shows a healthy sibling with its name, status dot, and link", async ({ page }) => {
  const siblingPort = await freePort();
  const primaryPort = await freePort();
  const sibling = await spawnDemo({ port: siblingPort });
  const primary = await spawnDemo({ port: primaryPort, siblingPort });
  try {
    await page.goto(`${primary.baseUrl}/__ashurbanipal`);
    await expect(page.locator("#siblings-heading")).toBeVisible();
    const item = page.locator("#siblings-list > div");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".dot")).toHaveClass(/up/);
    await expect(item.locator(".dot")).toHaveAttribute("aria-label", "healthy");
    await expect(item.locator("a")).toHaveText(`demo-${siblingPort}`);
    await expect(item.locator("a")).toHaveAttribute(
      "href",
      `http://localhost:${siblingPort}/__ashurbanipal`,
    );
  } finally {
    await primary.stop();
    await sibling.stop();
  }
});

test("shows an unhealthy sibling when it's down", async ({ page }) => {
  const deadPort = await freePort(); // nothing ever listens here
  const primaryPort = await freePort();
  const primary = await spawnDemo({ port: primaryPort, siblingPort: deadPort });
  try {
    await page.goto(`${primary.baseUrl}/__ashurbanipal`);
    await expect(page.locator("#siblings-heading")).toBeVisible();
    const item = page.locator("#siblings-list > div");
    await expect(item.locator(".dot")).toHaveClass(/down/);
    await expect(item.locator(".dot")).toHaveAttribute("aria-label", "unhealthy");
  } finally {
    await primary.stop();
  }
});
