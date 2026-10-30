import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { H2, PERF_DEMO_PORT } from "../playwright.perf.config";
import { APP_PATH } from "../tests/support/helpers";
import { type DelayProxy, type ServerDelays, startDelayProxy } from "./delay-proxy";

const DEEP_LINK = "?schema=warehouse&table=shipment_events";
const CHIP_TABLE = "shipments";
const HOVER_TABLE = "carriers";
// How long the pointer rests on a chip before the click in S8.
const HOVER_MS = 300;
const RUNS = Number(process.env.PERF_RUNS || 20);
const LABEL = process.env.PERF_LABEL || "";
const GZIP = process.env.PERF_GZIP === "1";
const PAGE = process.env.PERF_PAGE || undefined;

interface Network {
  name: string;
  latencyMs: number;
  mbps: number | null;
}
const NETWORKS: Network[] = [
  { name: "local", latencyMs: 0, mbps: null },
  { name: "same-region", latencyMs: 20, mbps: 50 },
  { name: "cross-region", latencyMs: 100, mbps: 20 },
  { name: "poor", latencyMs: 300, mbps: 1.5 },
].filter((n) =>
  process.env.PERF_NETWORKS ? process.env.PERF_NETWORKS.split(",").includes(n.name) : n.name !== "local",
);

const SERVERS: (ServerDelays & { name: string })[] = [
  { name: "no-delay", catalogMs: 0, dataMs: 0 },
  { name: "typical", catalogMs: 20, dataMs: 150 },
];

type Reason = "boot" | "chip" | "page" | "history";
type Sample = Record<string, number | null>;
interface Cell {
  network: string;
  server: string;
  scenario: string;
  samples: Sample[];
}
const cells: Cell[] = [];

let proxy: DelayProxy;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  proxy = await startDelayProxy(`http://127.0.0.1:${PERF_DEMO_PORT}`, { gzip: GZIP, h2: H2, page: PAGE });
});

test.afterAll(async ({ browser }) => {
  await proxy.close();
  if (cells.length > 0) writeResults(browser.version());
});

// The time of the last user action, on the same clock as the marks.
const ACTION_CLOCK = `
  addEventListener("click", (e) => { window.__perfActionAt = e.timeStamp; }, { capture: true });
  addEventListener("popstate", (e) => { window.__perfActionAt = e.timeStamp; });
`;

async function openPage(browser: Browser, network: Network): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: proxy.url });
  await context.addInitScript(ACTION_CLOCK);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // Bandwidth only; the proxy adds the round trip (delay-proxy.ts says why).
  const throughput = network.mbps === null ? -1 : (network.mbps * 1_000_000) / 8;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: throughput,
    uploadThroughput: throughput,
  });
  return { context, page };
}

// Resolves once the grid has rendered for `reason` after `after` (page clock).
async function waitRendered(page: Page, reason: Reason, after: number): Promise<number> {
  const handle = await page.waitForFunction(
    ([want, since]) => {
      const mark = performance.getEntriesByName("ashurbanipal:rows-rendered", "mark").at(-1) as
        | PerformanceMark
        | undefined;
      const got = (mark?.detail as { reason?: string } | null)?.reason;
      return mark && got === want && mark.startTime > since ? mark.startTime : false;
    },
    [reason, after] as const,
    { timeout: 60_000 },
  );
  return (await handle.jsonValue()) as number;
}

// Start-up from navigation start: marks, the HTML download, and the API
// requests that ran before the grid rendered.
function startupSample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const mark = (name: string) =>
      performance.getEntriesByName(`ashurbanipal:${name}`, "mark").at(-1)?.startTime ?? null;
    const rendered = mark("rows-rendered") ?? 0;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const api = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((e) => e.name.includes("/api/") && !e.name.includes("/api/siblings") && e.startTime < rendered)
      .sort((a, b) => a.startTime - b.startTime);
    // A wave is a request that had to wait for every earlier one to finish.
    let waves = 0;
    let busyUntil = Number.NEGATIVE_INFINITY;
    for (const e of api) {
      if (e.startTime >= busyUntil) waves++;
      busyUntil = Math.max(busyUntil, e.responseEnd);
    }
    return {
      rowsRenderedMs: rendered,
      tablesListedMs: mark("tables-listed"),
      scopeSettledMs: mark("scope-settled"),
      htmlDoneMs: nav.responseEnd,
      lastResponseMs: api.length ? Math.max(...api.map((e) => e.responseEnd)) : null,
      apiRequests: api.length,
      apiWaves: waves,
      kbTransferred: (nav.transferSize + api.reduce((sum, e) => sum + e.transferSize, 0)) / 1024,
    };
  });
}

async function actionAt(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __perfActionAt: number }).__perfActionAt);
}

// A view switch, from the user's action to the rendered grid.
async function switchSample(page: Page, reason: Reason, act: () => Promise<unknown>): Promise<Sample> {
  const before = await page.evaluate(() => performance.now());
  await act();
  const rendered = await waitRendered(page, reason, before);
  const at = await actionAt(page);
  const api = await page.evaluate(
    (since) =>
      performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/api/") && !e.name.includes("/api/siblings") && e.startTime >= since)
        .map((e) => ({ start: e.startTime, end: (e as PerformanceResourceTiming).responseEnd })),
    at,
  );
  return {
    rowsRenderedMs: rendered - at,
    // A switch whose rows were fetched ahead sends nothing after the action.
    firstRequestMs: api.length ? Math.min(...api.map((e) => e.start)) - at : null,
    lastResponseMs: api.length ? Math.max(...api.map((e) => e.end)) - at : null,
    apiRequests: api.length,
  };
}

function record(network: Network, server: string, scenario: string, sample: Sample): void {
  let cell = cells.find((c) => c.network === network.name && c.server === server && c.scenario === scenario);
  if (!cell) {
    cell = { network: network.name, server, scenario, samples: [] };
    cells.push(cell);
  }
  cell.samples.push(sample);
}

async function iteration(browser: Browser, network: Network, server: string, keep: boolean): Promise<void> {
  const save = (scenario: string, sample: Sample) => keep && record(network, server, scenario, sample);

  const fresh = await openPage(browser, network);
  await fresh.page.goto(APP_PATH);
  await waitRendered(fresh.page, "boot", 0);
  save("S1 fresh visit", await startupSample(fresh.page));
  await fresh.context.close();

  const { context, page } = await openPage(browser, network);
  await page.goto(APP_PATH + DEEP_LINK);
  await waitRendered(page, "boot", 0);
  save("S2 deep link", await startupSample(page));

  await page.reload();
  await waitRendered(page, "boot", 0);
  save("S3 reload", await startupSample(page));

  save(
    "S4 table chip",
    await switchSample(page, "chip", () => page.locator(`#tables [data-table="${CHIP_TABLE}"]`).click()),
  );
  save("S5 next page", await switchSample(page, "page", () => page.locator("#next").click()));
  save("S7 second next page", await switchSample(page, "page", () => page.locator("#next").click()));
  save("S6 back", await switchSample(page, "history", () => page.goBack({ waitUntil: "commit" })));
  const hoverChip = page.locator(`#tables [data-table="${HOVER_TABLE}"]`);
  save(
    "S8 hover, then chip",
    await switchSample(page, "chip", async () => {
      await hoverChip.hover();
      await page.waitForTimeout(HOVER_MS);
      await hoverChip.click();
    }),
  );
  await context.close();
}

// Round trip and server time must add up, as they do on a real network.
test("the simulated round trip and server time both reach every request", async ({ browser }) => {
  const network = { name: "check", latencyMs: 100, mbps: 20 };
  const server = SERVERS.find((s) => s.name === "typical")!;
  proxy.setDelays({ latencyMs: network.latencyMs, ...server });
  const { context, page } = await openPage(browser, network);
  await page.goto(APP_PATH);
  await waitRendered(page, "boot", 0);
  const timings = await page.evaluate(() => ({
    html: performance.getEntriesByType("navigation")[0].duration,
    protocol: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).nextHopProtocol,
    api: performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/api/"))
      .map((e) => ({ data: e.name.includes("/api/tables/data"), duration: e.duration })),
  }));
  await context.close();
  expect(timings.protocol).toBe(H2 ? "h2" : "http/1.1");
  expect(timings.html).toBeGreaterThanOrEqual(network.latencyMs);
  for (const { data, duration } of timings.api)
    expect(duration).toBeGreaterThanOrEqual(network.latencyMs + (data ? server.dataMs : server.catalogMs));
  expect(timings.api.some((r) => r.data)).toBe(true);
});

for (const network of NETWORKS) {
  for (const server of SERVERS) {
    test(`${network.name} network, ${server.name} server`, async ({ browser }) => {
      test.setTimeout(30 * 60_000);
      proxy.setDelays({ latencyMs: network.latencyMs, ...server });
      // Run 0 warms the demo's pool and the proxy's connections; it is not kept.
      for (let run = 0; run <= RUNS; run++) await iteration(browser, network, server.name, run > 0);
    });
  }
}

// ---- results ----

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stat(samples: Sample[], key: string): { median: number; p90: number } | null {
  const values = samples
    .map((s) => s[key])
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  return { median: percentile(values, 50), p90: percentile(values, 90) };
}

function writeResults(chromium: string): void {
  const git = (cmd: string) => execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
  const meta = {
    date: new Date().toISOString(),
    commit: git("rev-parse --short HEAD"),
    dirty: git("status --porcelain -- ../../frontend/src ../../implementations/rust") !== "",
    chromium,
    demoBuild: "release",
    label: LABEL,
    gzip: GZIP,
    h2: H2,
    page: PAGE ?? null,
    hoverMs: HOVER_MS,
    runs: RUNS,
    networks: NETWORKS,
    servers: SERVERS,
  };
  const ms = (v: number | undefined) => (v === undefined ? "–" : String(Math.round(v)));
  const lines = [
    `# Start-up timing${LABEL ? ` — ${LABEL}` : ""} — ${meta.date}`,
    "",
    `Commit ${meta.commit}${meta.dirty ? " (uncommitted changes)" : ""}, Chromium ${chromium}, release demo, ${H2 ? "HTTPS + HTTP/2" : "HTTP/1.1"}${GZIP ? ", gzip" : ""}${PAGE ? `, page ${PAGE}` : ""}, ${RUNS} runs per cell after one warm-up. Times in ms, median / p90.`,
    "",
    "| Scenario | Network | Server | Rows rendered | Last API response | Table list | API requests | API waves | KB |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const order = [...cells].sort((a, b) => a.scenario.localeCompare(b.scenario));
  for (const c of order) {
    const rows = stat(c.samples, "rowsRenderedMs");
    const response = stat(c.samples, "lastResponseMs");
    const tables = stat(c.samples, "tablesListedMs");
    const req = stat(c.samples, "apiRequests");
    const waves = stat(c.samples, "apiWaves");
    const kb = stat(c.samples, "kbTransferred");
    lines.push(
      `| ${c.scenario} | ${c.network} | ${c.server} | ${ms(rows?.median)} / ${ms(rows?.p90)} | ${ms(response?.median)} | ${
        tables ? `${ms(tables.median)} / ${ms(tables.p90)}` : "–"
      } | ${ms(req?.median)} | ${ms(waves?.median)} | ${ms(kb?.median)} |`,
    );
  }
  const stamp = `${LABEL ? `${LABEL.replace(/[^\w.+-]/g, "_")}-` : ""}${meta.date.replace(/[:.]/g, "-")}`;
  mkdirSync("perf-results", { recursive: true });
  writeFileSync(`perf-results/startup-${stamp}.json`, JSON.stringify({ meta, cells }, null, 2));
  writeFileSync(`perf-results/startup-${stamp}.md`, `${lines.join("\n")}\n`);
  console.log(`\n${lines.join("\n")}\n\nWritten to perf-results/startup-${stamp}.{json,md}`);
}
