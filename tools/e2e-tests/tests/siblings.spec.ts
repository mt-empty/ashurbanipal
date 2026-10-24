import { test, expect } from "./support/fixtures";
import { gotoApp } from "./support/helpers";
import { spawnDemo, freePort } from "./support/second-server";

// Sibling health-polling needs live instances, so each test spawns its own
// pair (as `mise run rust:demo-sibling` does) instead of using the shared server.

test("shows a healthy sibling with its name, status dot, and link", async ({ page }) => {
  const siblingPort = await freePort();
  const primaryPort = await freePort();
  const sibling = await spawnDemo({ port: siblingPort });
  const primary = await spawnDemo({ port: primaryPort, siblingPort });
  try {
    await gotoApp(page, "", primary.baseUrl);
    await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 up");
    await page.locator("#siblings-btn").click();
    const item = page.locator("#siblings-list > a");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".dot")).toHaveClass(/up/);
    await expect(item.locator(".dot")).toHaveAttribute("aria-label", "healthy");
    await expect(item.locator(".sibling-name")).toHaveText(`demo-${siblingPort}`);
    await expect(item).toHaveAttribute(
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
    await gotoApp(page, "", primary.baseUrl);
    await expect(page.locator("#siblings-summary")).toHaveText("Other services · 1 down");
    await page.locator("#siblings-btn").click();
    const item = page.locator("#siblings-list > a");
    await expect(item.locator(".dot")).toHaveClass(/down/);
    await expect(item.locator(".dot")).toHaveAttribute("aria-label", "unhealthy");
  } finally {
    await primary.stop();
  }
});
