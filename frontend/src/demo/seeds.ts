import shop from "./seeds/shop.sql";
import tracker from "./seeds/tracker.sql";
import type { DemoSource } from "./sources.js";

export const SEEDS: Record<DemoSource, string> = { shop, tracker };
