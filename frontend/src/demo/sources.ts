// The demo sources' names, in /api/sources order (the first is the default).
// Each is seeded from seeds/<name>.sql (seeds.ts) — the one data source for both demos.
export const DEMO_SOURCES = ["shop", "tracker"] as const;
export type DemoSource = (typeof DEMO_SOURCES)[number];
