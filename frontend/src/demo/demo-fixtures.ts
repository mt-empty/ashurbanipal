// Synthetic, deterministic data for the GitHub Pages demo (docs/demo/) —
// no live backend, no real schema. See demo-shim.ts for how this is served.
import type { Column } from "../types.js";

export type CellValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface TableDef {
  schema: string;
  name: string;
  comment?: string;
  columns: Column[];
  rowCount: number;
  // -1 on one table, deliberately, to exercise the real protocol's "no
  // cheap estimate yet" fallback (spec/protocol.md §5.3) in the demo too.
  approxRows: number;
  row(i: number): Record<string, CellValue>;
}

// mulberry32, seeded per (table, row) — same "deterministic fixed seed"
// convention as tools/seed-gen, so rebuilding without source edits
// reproduces byte-identical fixture data.
function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFor(table: string, row: number): () => number {
  return mulberry32(hashSeed(`${table}:${row}`));
}
function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}
function uuid(rng: () => number): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const g = (n: number) => Array.from({ length: n }, hex).join("");
  return `${g(8)}-${g(4)}-4${g(3)}-a${g(3)}-${g(12)}`;
}
function dateAt(rng: () => number, startYear = 2023): string {
  const day = Math.floor(rng() * 900);
  const d = new Date(Date.UTC(startYear, 0, 1) + day * 86400000);
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00`;
}

const FIRST = [
  "Alex",
  "Sam",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Jamie",
  "Drew",
  "Quinn",
  "Priya",
  "Wei",
  "Fatima",
  "Noah",
  "Ivy",
];
const LAST = ["Chen", "Patel", "Garcia", "Nguyen", "Smith", "Okafor", "Rossi", "Kim", "Novak", "Silva"];
// example.com/.org/.net are reserved for documentation (RFC 2606) — never
// resolve to anything real, so fixture emails/URLs can't look like a leak.
const DOMAINS = ["example.com", "mail.example.org", "example.net"];

const users: TableDef = {
  schema: "public",
  name: "users",
  comment: "Registered accounts.",
  columns: [
    { name: "id", type: "uuid", key: "pk" },
    { name: "email", type: "text" },
    { name: "display_name", type: "text" },
    { name: "is_admin", type: "boolean" },
    { name: "signup_source", type: "jsonb", comment: "Attribution captured at signup." },
    { name: "created_at", type: "timestamp with time zone" },
  ],
  rowCount: 64,
  approxRows: 61,
  row(i) {
    const rng = rngFor("users", i);
    const first = pick(rng, FIRST),
      last = pick(rng, LAST);
    return {
      id: uuid(rng),
      email: `${`${first}.${last}${i}`.toLowerCase()}@${pick(rng, DOMAINS)}`,
      display_name: `${first} ${last}`,
      is_admin: rng() < 0.06,
      signup_source: {
        campaign: pick(rng, ["organic", "referral", "ads", "newsletter"]),
        utm_ref: rng() < 0.5 ? pick(rng, ["hn", "reddit", "twitter"]) : null,
      },
      created_at: dateAt(rng),
    };
  },
};

const products: TableDef = {
  schema: "public",
  name: "products",
  comment: "Catalog items.",
  columns: [
    { name: "id", type: "uuid", key: "pk" },
    { name: "name", type: "text" },
    { name: "tags", type: "jsonb" },
    { name: "price_cents", type: "integer" },
    { name: "metadata", type: "jsonb", comment: "Vendor-supplied attributes, shape varies by category." },
  ],
  rowCount: 48,
  approxRows: 45,
  row(i) {
    const rng = rngFor("products", i);
    const category = pick(rng, ["electronics", "home", "outdoors", "books", "toys"]);
    const noun = pick(rng, ["Widget", "Gadget", "Kit", "Set", "Case", "Lamp", "Mug", "Sensor"]);
    return {
      id: uuid(rng),
      name: `${category[0].toUpperCase()}${category.slice(1)} ${noun} ${i}`,
      tags: [category, rng() < 0.4 ? "sale" : "new"],
      price_cents: Math.floor(rng() * 9800) + 200,
      metadata: { category, weight_kg: Math.round(rng() * 2000) / 100, in_stock: rng() < 0.85 },
    };
  },
};

const orders: TableDef = {
  schema: "public",
  name: "orders",
  columns: [
    { name: "id", type: "uuid", key: "pk" },
    { name: "user_id", type: "uuid", key: "fk", references: { table: "users", column: "id" } },
    { name: "status", type: "text", comment: "Order lifecycle state." },
    { name: "total_cents", type: "integer" },
    { name: "notes", type: "text" },
    { name: "created_at", type: "timestamp with time zone" },
  ],
  rowCount: 96,
  approxRows: 89,
  row(i) {
    const rng = rngFor("orders", i);
    const userIdx = Math.floor(rng() * users.rowCount);
    return {
      id: uuid(rng),
      user_id: users.row(userIdx).id,
      status: pick(rng, ["pending", "paid", "shipped", "delivered", "cancelled"]),
      total_cents: Math.floor(rng() * 48000) + 500,
      notes: rng() < 0.3 ? null : pick(rng, ["gift wrap requested", "leave at door", "call on arrival"]),
      created_at: dateAt(rng),
    };
  },
};

const orderItems: TableDef = {
  schema: "public",
  name: "order_items",
  columns: [
    { name: "id", type: "uuid", key: "pk" },
    { name: "order_id", type: "uuid", key: "fk", references: { table: "orders", column: "id" } },
    { name: "product_id", type: "uuid", key: "fk", references: { table: "products", column: "id" } },
    { name: "quantity", type: "integer" },
    { name: "unit_price_cents", type: "integer" },
  ],
  rowCount: 240,
  approxRows: -1,
  row(i) {
    const rng = rngFor("order_items", i);
    const orderIdx = Math.floor(rng() * orders.rowCount);
    const productIdx = Math.floor(rng() * products.rowCount);
    return {
      id: uuid(rng),
      order_id: orders.row(orderIdx).id,
      product_id: products.row(productIdx).id,
      quantity: Math.floor(rng() * 4) + 1,
      unit_price_cents: Math.floor(rng() * 12000) + 199,
    };
  },
};

// 1:1 "detail table" shape — user_id is simultaneously this table's PK and
// a FK to users(id), same as spec/protocol.md §5.4.1's key-precedence example.
const userProfiles: TableDef = {
  schema: "public",
  name: "user_profiles",
  columns: [
    { name: "user_id", type: "uuid", key: "pk", references: { table: "users", column: "id" } },
    { name: "bio", type: "text" },
    { name: "avatar_url", type: "text" },
  ],
  rowCount: 40,
  approxRows: 40,
  row(i) {
    const rng = rngFor("user_profiles", i);
    return {
      user_id: users.row(i).id,
      bio:
        rng() < 0.2
          ? null
          : pick(rng, [
              "Coffee-powered engineer.",
              "Cat parent.",
              "Runs on weekends.",
              "Still learning SQL.",
              "Here for the data.",
            ]),
      avatar_url: rng() < 0.5 ? null : `https://example.com/avatars/${i}.png`,
    };
  },
};

const dailySummary: TableDef = {
  schema: "reporting",
  name: "daily_summary",
  columns: [
    { name: "summary_date", type: "date", key: "pk" },
    { name: "total_orders", type: "integer" },
    { name: "total_revenue_cents", type: "integer" },
    { name: "notes", type: "jsonb" },
  ],
  rowCount: 30,
  approxRows: 30,
  row(i) {
    const rng = rngFor("daily_summary", i);
    const d = new Date(Date.UTC(2026, 6, 1) + i * 86400000);
    return {
      summary_date: d.toISOString().slice(0, 10),
      total_orders: Math.floor(rng() * 300) + 20,
      total_revenue_cents: Math.floor(rng() * 900000) + 30000,
      notes:
        rng() < 0.7
          ? null
          : {
              flagged: true,
              reason: pick(rng, ["payment provider outage", "holiday spike", "data backfill"]),
            },
    };
  },
};

const signupFunnel: TableDef = {
  schema: "reporting",
  name: "signup_funnel",
  columns: [
    { name: "id", type: "uuid", key: "pk" },
    { name: "stage", type: "text" },
    { name: "count", type: "integer" },
    { name: "captured_at", type: "timestamp with time zone" },
  ],
  rowCount: 20,
  approxRows: 20,
  row(i) {
    const rng = rngFor("signup_funnel", i);
    return {
      id: uuid(rng),
      stage: pick(rng, ["visited", "signed_up", "verified_email", "completed_profile", "first_order"]),
      count: Math.floor(rng() * 5000) + 100,
      captured_at: dateAt(rng, 2026),
    };
  },
};

export const TABLES: TableDef[] = [users, orders, orderItems, products, userProfiles, dailySummary, signupFunnel];

export const SCHEMAS = ["public", "reporting"];

export const SIBLINGS = [
  { name: "billing (demo)", base_url: "https://billing.example.com/__ashurbanipal", healthy: true },
  { name: "notifications (demo)", base_url: "https://notifications.example.com/__ashurbanipal", healthy: false },
];
