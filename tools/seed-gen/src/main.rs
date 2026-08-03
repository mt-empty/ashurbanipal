//! Generates `.devcontainer/db/init/01-seed.sql`. Not part of the
//! `ashurbanipal` crate or its examples — a standalone dev-only tool, so
//! `fake`/`rand` never touch the library's own dependency tree.
//!
//! Regenerate after changing anything below:
//!
//! ```sh
//! cd tools/seed-gen
//! cargo run > ../../.devcontainer/db/init/01-seed.sql
//! ```
//!
//! Deterministic (fixed RNG seed) so regenerating without edits produces an
//! identical file — diffs only show up when the generator itself changes.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt::Write as _;

use fake::faker::company::en::Buzzword;
use fake::faker::internet::en::{IPv4, SafeEmail};
use fake::faker::lorem::en::{Paragraph, Paragraphs};
use fake::faker::name::en::Name;
use fake::rand::rngs::StdRng;
use fake::rand::seq::IndexedRandom;
use fake::rand::{RngExt, SeedableRng};
use fake::Fake;
use uuid::Uuid;

const SEED: u64 = 20260716;
const USER_COUNT: usize = 50;
const PRODUCT_COUNT: usize = 80;
const EVENT_COUNT: usize = 400;
const SESSION_COUNT: usize = 120;
// Two "tens of thousands" tables, per the E2E-fixture brief: enough rows
// that pagination/virtualization/large-count UI paths are actually
// exercised rather than always seeing a handful of rows.
const REVIEWS_PER_PRODUCT_MIN: u32 = 130;
const REVIEWS_PER_PRODUCT_MAX: u32 = 220;
const SUPPORT_TICKET_COUNT: usize = 350;
const AUDIT_LOG_COUNT: usize = 30_000;
// `feature_flags` is the deliberately-never-`analyze`d table (conformance
// fixture: empty common-values list, `-1` approx_rows before first
// ANALYZE/VACUUM) — see the `analyze` block in `main()`.
const FEATURE_FLAG_COUNT: usize = 6;
const INVENTORY_COUNT_ROWS: usize = 40;

/// Schema/content version stamped into `_conformance_meta` — the sentinel
/// `conformance/runner` checks for when it isn't asked to apply the seed
/// itself. Single source of truth shared with the runner via
/// `conformance/seed/VERSION`; bump that file (not this constant) when the
/// seed's shape changes in a way conformance tests depend on.
const CONFORMANCE_VERSION: &str = include_str!("../../../conformance/seed/VERSION");

/// Fixed anchor instant/date. Every generated timestamp/date is rendered as
/// this literal minus/offset by a (seeded-random, so still deterministic)
/// interval, instead of `now() - interval ...` / `current_date - N`. Those
/// forms bake in the wall-clock moment `01-seed.sql` actually runs against
/// Postgres, so the *rendered* date/time text drifts every time the
/// devcontainer is reseeded — bad for anything that asserts on or
/// screenshots rendered dates. The RNG-picked offsets stay exactly as
/// deterministic as before; only the reference point they're offset from is
/// now fixed instead of floating. Column *defaults* in the DDL (`default
/// now()`, `default current_date`) are untouched — those are for the host
/// app's own future writes, not this script's own INSERT values.
const ANCHOR_TS: &str = "2026-07-19 00:00:00+00";
const ANCHOR_DATE: &str = "2026-07-19";

const ROLE_POOL: [&str; 6] = ["admin", "user", "user", "user", "support", "moderator"];
/// Roles treated as "staff" for picking a plausible assignee/processor on
/// the new tables below (`support_tickets.assigned_admin_id`,
/// `payments.processed_by_user_id`) — plain users are never assigned a
/// ticket or shown as having manually processed a payment.
const STAFF_ROLES: [&str; 3] = ["admin", "support", "moderator"];

const ORDER_STATUSES: [&str; 6] = [
    "pending",
    "completed",
    "completed",
    "completed",
    "cancelled",
    "refunded",
];
const ORDER_TAG_POOL: [&str; 5] = ["priority", "gift-wrap", "backorder", "fragile", "international"];

const SESSION_DEVICES: [&str; 4] = ["desktop", "mobile", "tablet", "bot"];
const SESSION_USER_AGENTS: [&str; 5] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "curl/8.7.1",
];

/// Escape a value for a single-quoted SQL string literal.
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// v4 UUID drawn from the seeded RNG — `Uuid::new_v4()` uses the system RNG
/// instead, which would break reproducibility.
fn gen_uuid(rng: &mut StdRng) -> Uuid {
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

/// `TIMESTAMPTZ` literal for the fixed anchor minus `mins` minutes — see
/// `ANCHOR_TS`.
fn ts_minus_mins(mins: u32) -> String {
    format!("TIMESTAMPTZ '{ANCHOR_TS}' - interval '{mins} minutes'")
}

/// `DATE` literal for the fixed anchor minus `days` days — see
/// `ANCHOR_DATE`.
fn date_minus_days(days: u32) -> String {
    format!("DATE '{ANCHOR_DATE}' - {days}")
}

/// `TIMESTAMPTZ` literal for the fixed anchor minus `days` days.
fn ts_minus_days(days: u32) -> String {
    format!("TIMESTAMPTZ '{ANCHOR_TS}' - interval '{days} days'")
}

fn uuid_sql(o: Option<Uuid>) -> String {
    o.map(|id| format!("'{id}'")).unwrap_or_else(|| "NULL".into())
}

fn int_sql(o: Option<i64>) -> String {
    o.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into())
}

/// `bytea` hex-format literal (`'\x...'::bytea`), or `NULL`.
fn bytea_sql(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(b) => {
            let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("'\\x{hex}'::bytea")
        }
        None => "NULL".into(),
    }
}

/// FNV-1a 64-bit — informational only (`_conformance_meta.checksum`); the
/// runner's staleness check is the `seed_version` column, not this hash, so
/// there's no need to pull in a real hashing crate for a value nothing
/// re-derives.
fn fnv1a64(data: &str) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET_BASIS;
    for byte in data.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn main() {
    let mut rng = StdRng::seed_from_u64(SEED);
    let mut out = String::new();

    write_header(&mut out);
    write_schema(&mut out);

    let users = gen_users(&mut rng);
    write_users(&mut out, &users);

    let orders = gen_orders(&mut rng, &users);
    write_orders(&mut out, &orders);

    write_products(&mut out, &mut rng);
    write_events(&mut out, &mut rng, &users);

    let sessions = gen_sessions(&mut rng, &users);
    write_sessions(&mut out, &sessions);

    // Index used by the new tables below to pick a *plausible* FK target
    // instead of any random row — e.g. a review's "verified purchase"
    // order must belong to that same review's user.
    let mut orders_by_user: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for o in &orders {
        orders_by_user.entry(o.user_id).or_default().push(o.id);
    }
    let staff_users: Vec<&GenUser> = users
        .iter()
        .filter(|u| STAFF_ROLES.contains(&u.role))
        .collect();

    write_reviews(&mut out, &mut rng, &users, &orders_by_user);
    write_support_tickets(&mut out, &mut rng, &users, &staff_users, &orders_by_user);
    write_payments(&mut out, &mut rng, &orders, &staff_users);
    write_audit_log(&mut out, &mut rng, &users, &sessions);
    // saved_reports gets zero rows on purpose (see write_schema) — no
    // insert statement at all, just the `analyze` below so its
    // `pg_class.reltuples` reads back as 0 rather than -1.

    let locations = write_inventory_locations(&mut out, &mut rng);
    write_inventory_counts(&mut out, &mut rng, &locations);
    write_feature_flags(&mut out, &mut rng);
    // feature_flags is deliberately excluded from analyze below.

    out.push_str(
        "\n-- pg_class.reltuples is only populated by ANALYZE/autovacuum; without this,\n\
         -- a freshly seeded dev db shows -1 via /table-counts until autovacuum runs. This\n\
         -- also matters for saved_reports specifically: it has zero rows by design (an\n\
         -- empty-table UI state), and without an ANALYZE it wouldn't show up in pg_stats\n\
         -- at all, which would look like \"never analyzed\" rather than \"genuinely empty\".\n\
         analyze users;\n\
         analyze orders;\n\
         analyze products;\n\
         analyze events;\n\
         analyze sessions;\n\
         analyze reviews;\n\
         analyze support_tickets;\n\
         analyze payments;\n\
         analyze audit_log;\n\
         analyze saved_reports;\n\
         analyze inventory_locations;\n\
         analyze inventory_counts;\n",
    );

    write_conformance_meta(&mut out);

    print!("{out}");
}

fn write_header(out: &mut String) {
    out.push_str(
        "-- GENERATED FILE — do not hand-edit.\n\
         -- Source: tools/seed-gen (`cargo run` from that directory, output redirected here).\n\
         -- Realistic, varied data for exercising the Ashurbanipal DB browser: ten tables\n\
         -- spanning uuid/bigint-identity PKs, enums, numeric/real, arrays, inet, jsonb,\n\
         -- date/timestamptz, varchar(n), and NULLs throughout, plus single-column FKs\n\
         -- (including two distinct FK columns from one table to the same target) and one\n\
         -- deliberately empty table. Idempotent (drops first) so it can be re-run against\n\
         -- a live dev db.\n\n\
         create extension if not exists pgcrypto;\n\n\
         -- A second schema with its own table, same name pattern as nothing else here —\n\
         -- the conformance fixture proving every catalog/data query is scoped to\n\
         -- current_schema() (spec/protocol.md §6) rather than enumerating every schema\n\
         -- on the connection: `decoy_items` must never appear in `/api/tables` (the\n\
         -- connection's `current_schema()` is `public`), and must be rejected as an\n\
         -- unknown table if requested directly.\n\
         drop schema if exists other_schema cascade;\n\
         create schema other_schema;\n\
         create table other_schema.decoy_items (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   label text not null\n\
         );\n\
         insert into other_schema.decoy_items (label) values ('decoy-1'), ('decoy-2');\n\n\
         -- New tables are dropped before the originals they reference — `cascade` handles\n\
         -- dependent constraints/views either way, but this keeps the drop order honest.\n\
         drop table if exists _conformance_meta cascade;\n\
         drop table if exists feature_flags cascade;\n\
         drop table if exists inventory_counts cascade;\n\
         drop table if exists inventory_locations cascade;\n\
         drop table if exists audit_log cascade;\n\
         drop table if exists payments cascade;\n\
         drop table if exists support_tickets cascade;\n\
         drop table if exists reviews cascade;\n\
         drop table if exists saved_reports cascade;\n\
         drop table if exists sessions cascade;\n\
         drop table if exists events cascade;\n\
         drop table if exists orders cascade;\n\
         drop table if exists products cascade;\n\
         drop table if exists users cascade;\n\
         drop type if exists ticket_status cascade;\n\
         drop type if exists payment_status cascade;\n\
         drop type if exists order_status cascade;\n\
         drop type if exists product_category cascade;\n\n",
    );
}

fn write_schema(out: &mut String) {
    out.push_str(
        "create type order_status as enum ('pending', 'completed', 'cancelled', 'refunded');\n\
         create type product_category as enum ('electronics', 'books', 'home', 'toys', 'apparel');\n\
         create type ticket_status as enum ('open', 'in_progress', 'resolved', 'closed');\n\
         create type payment_status as enum ('pending', 'succeeded', 'failed', 'refunded');\n\n\
         create table users (\n\
         \x20   id uuid primary key,\n\
         \x20   email text not null unique,\n\
         \x20   full_name text not null,\n\
         \x20   age smallint,\n\
         \x20   is_active boolean not null default true,\n\
         \x20   login_count integer not null default 0,\n\
         \x20   metadata jsonb not null default '{}',\n\
         \x20   last_login_at timestamptz,\n\
         \x20   created_at timestamptz not null default now()\n\
         );\n\n\
         create table orders (\n\
         \x20   id uuid primary key default gen_random_uuid(),\n\
         \x20   user_id uuid not null references users(id),\n\
         \x20   status order_status not null default 'pending',\n\
         \x20   total_cents integer not null,\n\
         \x20   discount_pct numeric(5,2),\n\
         \x20   tags text[],\n\
         \x20   line_items jsonb not null default '[]',\n\
         \x20   created_at timestamptz not null default now()\n\
         );\n\n\
         create table products (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   sku varchar(20) not null unique,\n\
         \x20   name text not null,\n\
         \x20   category product_category not null,\n\
         \x20   price numeric(10,2) not null,\n\
         \x20   weight_kg real,\n\
         \x20   in_stock boolean not null default true,\n\
         \x20   description text,\n\
         \x20   created_on date not null default current_date\n\
         );\n\n\
         create table events (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   user_id uuid references users(id),\n\
         \x20   event_type text not null,\n\
         \x20   payload jsonb not null default '{}',\n\
         \x20   ip_address inet,\n\
         \x20   duration_ms integer,\n\
         \x20   occurred_at timestamptz not null default now(),\n\
         \x20   is_test boolean not null default false\n\
         );\n\n\
         create table sessions (\n\
         \x20   id uuid primary key default gen_random_uuid(),\n\
         \x20   user_id uuid not null references users(id),\n\
         \x20   device_type varchar(20) not null,\n\
         \x20   user_agent text not null,\n\
         \x20   ip_address inet,\n\
         \x20   started_at timestamptz not null,\n\
         \x20   ended_at timestamptz\n\
         );\n\n\
         create table reviews (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   user_id uuid not null references users(id),\n\
         \x20   product_id bigint not null references products(id),\n\
         \x20   order_id uuid references orders(id),\n\
         \x20   rating smallint not null,\n\
         \x20   title text,\n\
         \x20   body text,\n\
         \x20   is_verified_purchase boolean not null default false,\n\
         \x20   created_at timestamptz not null default now()\n\
         );\n\n\
         create table support_tickets (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   user_id uuid not null references users(id),\n\
         \x20   assigned_admin_id uuid references users(id),\n\
         \x20   order_id uuid references orders(id),\n\
         \x20   subject text not null,\n\
         \x20   description text not null,\n\
         \x20   status ticket_status not null default 'open',\n\
         \x20   created_at timestamptz not null,\n\
         \x20   resolved_at timestamptz\n\
         );\n\n\
         create table payments (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   order_id uuid not null references orders(id),\n\
         \x20   processed_by_user_id uuid references users(id),\n\
         \x20   related_event_id bigint references events(id),\n\
         \x20   amount_cents integer not null,\n\
         \x20   status payment_status not null default 'pending',\n\
         \x20   gateway_response jsonb not null default '{}',\n\
         \x20   created_at timestamptz not null\n\
         );\n\n\
         create table audit_log (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   actor_user_id uuid references users(id),\n\
         \x20   session_id uuid references sessions(id),\n\
         \x20   event_id bigint references events(id),\n\
         \x20   action text not null,\n\
         \x20   details jsonb not null default '{}',\n\
         \x20   occurred_at timestamptz not null\n\
         );\n\n\
         -- Deliberately zero rows (see main()'s analyze block) — exercises the UI's\n\
         -- genuine empty-table state rather than the \"stats not populated yet\" one.\n\
         create table saved_reports (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   name text not null,\n\
         \x20   is_public boolean not null default false,\n\
         \x20   created_at timestamptz not null default now()\n\
         );\n\n\
         -- Composite primary key: inventory_counts' (warehouse_code, bin_code) FK\n\
         -- below references this pair together, never either column alone — the\n\
         -- conformance fixture for \"composite FKs omit key/references metadata\n\
         -- entirely\" (spec/protocol.md §5.4.1).\n\
         create table inventory_locations (\n\
         \x20   warehouse_code varchar(10) not null,\n\
         \x20   bin_code varchar(10) not null,\n\
         \x20   label text,\n\
         \x20   capacity integer not null default 100,\n\
         \x20   primary key (warehouse_code, bin_code)\n\
         );\n\n\
         -- product_id is an ordinary single-column FK (contrast with the composite\n\
         -- one below); photo is the bytea fixture.\n\
         create table inventory_counts (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   warehouse_code varchar(10) not null,\n\
         \x20   bin_code varchar(10) not null,\n\
         \x20   product_id bigint references products(id),\n\
         \x20   quantity integer not null,\n\
         \x20   photo bytea,\n\
         \x20   counted_at timestamptz not null default now(),\n\
         \x20   foreign key (warehouse_code, bin_code) references inventory_locations(warehouse_code, bin_code)\n\
         );\n\n\
         -- Deliberately never ANALYZEd (see main()) — the empty-common-values and\n\
         -- -1-approx_rows conformance fixture.\n\
         create table feature_flags (\n\
         \x20   id bigint generated always as identity primary key,\n\
         \x20   key text not null unique,\n\
         \x20   enabled boolean not null default true,\n\
         \x20   rollout_pct smallint,\n\
         \x20   created_at timestamptz not null default now()\n\
         );\n\n\
         -- Conformance sentinel (conformance/runner reads this when it isn't asked\n\
         -- to apply the seed itself) — see write_conformance_meta().\n\
         create table _conformance_meta (\n\
         \x20   seed_version text not null,\n\
         \x20   checksum text not null,\n\
         \x20   generated_at timestamptz not null default now()\n\
         );\n\n",
    );
    // A deliberately partial set of `comment on` statements — most
    // tables/columns are left uncommented so the demo also exercises the
    // no-comment (absent `title=`) path, not just the happy path. Kept
    // partial across the new tables too: reviews and support_tickets get
    // comments, payments/audit_log/saved_reports don't.
    out.push_str(
        "comment on table users is 'Registered application users.';\n\
         comment on column users.metadata is \
         'Free-form per-user preferences and feature flags, stored as JSON.';\n\n\
         comment on table orders is \
         'Customer orders placed against the product catalog.';\n\
         comment on column orders.user_id is \
         'The user who placed this order.';\n\
         comment on column orders.discount_pct is \
         'Percentage discount applied at checkout, if any.';\n\n\
         comment on table sessions is \
         'Login sessions, one row per device/browser session.';\n\n\
         comment on table reviews is \
         'Product reviews left by users, optionally tied to a verified order.';\n\n\
         comment on table support_tickets is \
         'Customer support tickets, optionally assigned to a staff user.';\n\
         comment on column support_tickets.description is \
         'Full ticket body as submitted by the customer.';\n\n\
         comment on table _conformance_meta is \
         'Conformance-suite sentinel row; not part of the application schema.';\n\n",
    );
}

struct GenUser {
    id: Uuid,
    email: String,
    full_name: String,
    age: Option<u8>,
    is_active: bool,
    login_count: u32,
    metadata: String, // pre-built JSON text
    role: &'static str,
    last_login_offset_mins: Option<u32>,
    created_offset_days: u32,
}

fn gen_users(rng: &mut StdRng) -> Vec<GenUser> {
    let mut seen_emails = HashSet::new();
    let mut users = Vec::with_capacity(USER_COUNT);

    for _ in 0..USER_COUNT {
        let full_name: String = Name().fake_with_rng(rng);
        let email = loop {
            let candidate: String = SafeEmail().fake_with_rng::<String, _>(rng);
            if seen_emails.insert(candidate.clone()) {
                break candidate;
            }
        };
        let age = if rng.random_bool(0.1) {
            None
        } else {
            Some(rng.random_range(18..75))
        };
        let role = *ROLE_POOL.choose(rng).unwrap();
        let mut metadata = format!(r#"{{"role": "{role}""#);
        if rng.random_bool(0.5) {
            let theme = if rng.random_bool(0.5) { "dark" } else { "light" };
            let _ = write!(metadata, r#", "prefs": {{"theme": "{theme}"}}"#);
        }
        if rng.random_bool(0.15) {
            metadata.push_str(r#", "beta_features": ["new_dashboard"]"#);
        }
        metadata.push('}');

        users.push(GenUser {
            id: gen_uuid(rng),
            email,
            full_name,
            age,
            is_active: rng.random_bool(0.85),
            login_count: rng.random_range(0..500),
            metadata,
            role,
            last_login_offset_mins: if rng.random_bool(0.15) {
                None
            } else {
                Some(rng.random_range(10..130_000))
            },
            created_offset_days: rng.random_range(1..400),
        });
    }
    users
}

fn write_users(out: &mut String, users: &[GenUser]) {
    out.push_str("insert into users (id, email, full_name, age, is_active, login_count, metadata, last_login_at, created_at) values\n");
    for (i, u) in users.iter().enumerate() {
        let age = u.age.map(|a| a.to_string()).unwrap_or_else(|| "NULL".into());
        let last_login = match u.last_login_offset_mins {
            Some(mins) => ts_minus_mins(mins),
            None => "NULL".into(),
        };
        let sep = if i + 1 == users.len() { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{id}', {email}, {name}, {age}, {active}, {logins}, '{meta}'::jsonb, {last_login}, {created}){sep}",
            id = u.id,
            email = q(&u.email),
            name = q(&u.full_name),
            active = u.is_active,
            logins = u.login_count,
            meta = u.metadata.replace('\'', "''"),
            created = ts_minus_days(u.created_offset_days),
        )
        .unwrap();
    }
}

struct GenOrder {
    id: Uuid,
    user_id: Uuid,
    status: &'static str,
    total_cents: i32,
    discount_pct: Option<f64>,
    tags: Option<Vec<&'static str>>,
    line_items: Vec<String>, // pre-built JSON object text per item
    created_offset_mins: u32,
}

fn gen_orders(rng: &mut StdRng, users: &[GenUser]) -> Vec<GenOrder> {
    let mut orders = Vec::new();

    for u in users {
        let n_orders = rng.random_range(0..9);
        for _ in 0..n_orders {
            let status = *ORDER_STATUSES.choose(rng).unwrap();
            let total_cents = rng.random_range(300..25_000);
            let discount_pct = if rng.random_bool(0.3) {
                Some(rng.random_range(200..4000) as f64 / 100.0)
            } else {
                None
            };
            let tags = if rng.random_bool(0.3) {
                let n = rng.random_range(1..=2);
                Some(ORDER_TAG_POOL.sample(rng, n).copied().collect())
            } else {
                None
            };
            let n_items = rng.random_range(1..=4);
            let line_items: Vec<String> = (0..n_items)
                .map(|_| {
                    format!(
                        r#"{{"sku": "WIDGET-{}", "qty": {}}}"#,
                        rng.random_range(1000..9999),
                        rng.random_range(1..4)
                    )
                })
                .collect();
            let created_offset_mins = rng.random_range(60..288_000);
            orders.push(GenOrder {
                id: gen_uuid(rng),
                user_id: u.id,
                status,
                total_cents,
                discount_pct,
                tags,
                line_items,
                created_offset_mins,
            });
        }
    }
    orders
}

fn write_orders(out: &mut String, orders: &[GenOrder]) {
    out.push_str("insert into orders (id, user_id, status, total_cents, discount_pct, tags, line_items, created_at) values\n");
    let n = orders.len();
    for (i, o) in orders.iter().enumerate() {
        let discount_sql = o
            .discount_pct
            .map(|d| format!("{d:.2}"))
            .unwrap_or_else(|| "NULL".into());
        let tags_sql = match &o.tags {
            Some(t) => format!(
                "array[{}]",
                t.iter().map(|s| q(s)).collect::<Vec<_>>().join(", ")
            ),
            None => "NULL".into(),
        };
        let items_sql = format!("'[{}]'::jsonb", o.line_items.join(", "));
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{id}', '{user_id}', '{status}', {total_cents}, {discount_sql}, {tags_sql}, {items_sql}, {created}){sep}",
            id = o.id,
            user_id = o.user_id,
            status = o.status,
            total_cents = o.total_cents,
            created = ts_minus_mins(o.created_offset_mins),
        )
        .unwrap();
    }
}

fn write_products(out: &mut String, rng: &mut StdRng) {
    let categories: [(&str, &str, &[&str]); 5] = [
        ("electronics", "ELEC", &["Mouse", "Keyboard", "Monitor", "Webcam", "Speaker", "Charger", "Router", "Headphones"]),
        ("books", "BOOK", &["Programming Guide", "Design Handbook", "Field Notes", "Reference Manual", "Anthology"]),
        ("home", "HOME", &["Mug", "Desk Lamp", "Blanket", "Organizer", "Candle", "Planter"]),
        ("toys", "TOYS", &["Building Blocks", "Puzzle", "Action Figure", "Board Game", "Plush Toy"]),
        ("apparel", "APRL", &["Socks", "Jacket", "Tote Bag", "Cap", "Scarf", "Gloves"]),
    ];
    let mut counters = [1000u32; 5];

    out.push_str("insert into products (sku, name, category, price, weight_kg, in_stock, description, created_on) values\n");
    for i in 0..PRODUCT_COUNT {
        let cat_idx = rng.random_range(0..categories.len());
        let (category, prefix, nouns) = categories[cat_idx];
        counters[cat_idx] += 1;
        let sku = format!("{prefix}-{}", counters[cat_idx]);
        let buzzword: String = Buzzword().fake_with_rng(rng);
        let noun = nouns.choose(rng).unwrap();
        let name = format!("{buzzword} {noun}");
        let price = rng.random_range(500..50_000) as f64 / 100.0;
        let weight = if rng.random_bool(0.1) {
            None
        } else {
            Some(rng.random_range(5..1500) as f32 / 100.0)
        };
        let in_stock = rng.random_bool(0.8);
        let description = if rng.random_bool(0.5) {
            let p: String = Paragraph(1..3).fake_with_rng(rng);
            Some(p)
        } else {
            None
        };
        let created_days_ago = rng.random_range(1..400);

        let weight_sql = weight
            .map(|w| format!("{w:.2}"))
            .unwrap_or_else(|| "NULL".into());
        let desc_sql = description.map(|d| q(&d)).unwrap_or_else(|| "NULL".into());
        let sep = if i + 1 == PRODUCT_COUNT { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ({sku}, {name}, {category}, {price:.2}, {weight_sql}, {in_stock}, {desc_sql}, {created}){sep}",
            sku = q(&sku),
            name = q(&name),
            category = q(category),
            created = date_minus_days(created_days_ago),
        )
        .unwrap();
    }
}

fn write_events(out: &mut String, rng: &mut StdRng, users: &[GenUser]) {
    let event_types = [
        "page_view",
        "click",
        "signup",
        "purchase",
        "error",
        "logout",
        "search",
        "add_to_cart",
    ];
    let paths = ["/app/dashboard", "/app/settings", "/app/billing", "/app/profile", "/app/search"];

    out.push_str("insert into events (user_id, event_type, payload, ip_address, duration_ms, occurred_at, is_test) values\n");
    for i in 0..EVENT_COUNT {
        let user_id = if rng.random_bool(0.12) {
            None
        } else {
            Some(users.choose(rng).unwrap().id)
        };
        let event_type = *event_types.choose(rng).unwrap();
        let path = *paths.choose(rng).unwrap();
        let ip: String = IPv4().fake_with_rng(rng);
        let duration = if rng.random_bool(0.2) {
            None
        } else {
            Some(rng.random_range(5..5000))
        };
        let occurred_mins_ago = rng.random_range(1..130_000);
        let is_test = rng.random_bool(0.05);

        let user_sql = user_id
            .map(|id| format!("'{id}'"))
            .unwrap_or_else(|| "NULL".into());
        let duration_sql = duration
            .map(|d| d.to_string())
            .unwrap_or_else(|| "NULL".into());
        let payload = format!(r#"'{{"path": "{path}", "n": {i}}}'::jsonb"#);
        let sep = if i + 1 == EVENT_COUNT { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ({user_sql}, {et}, {payload}, {ip_sql}::inet, {duration_sql}, {occurred}, {is_test}){sep}",
            et = q(event_type),
            ip_sql = q(&ip),
            occurred = ts_minus_mins(occurred_mins_ago),
        )
        .unwrap();
    }
}

struct GenSession {
    id: Uuid,
    started_offset_mins: u32,
    ended_offset_mins: Option<u32>,
    device: &'static str,
    user_agent: &'static str,
    ip: String,
    user_id: Uuid,
}

fn gen_sessions(rng: &mut StdRng, users: &[GenUser]) -> Vec<GenSession> {
    let mut sessions = Vec::with_capacity(SESSION_COUNT);
    for _ in 0..SESSION_COUNT {
        let user_id = users.choose(rng).unwrap().id;
        let device = *SESSION_DEVICES.choose(rng).unwrap();
        let user_agent = *SESSION_USER_AGENTS.choose(rng).unwrap();
        let ip: String = IPv4().fake_with_rng(rng);
        // started far enough in the past that a plausible session length still lands >= 0.
        let started_offset_mins = rng.random_range(300..90_000);
        let ended_offset_mins = if rng.random_bool(0.2) {
            None
        } else {
            let length = rng.random_range(1..180);
            Some(started_offset_mins - length)
        };
        sessions.push(GenSession {
            id: gen_uuid(rng),
            started_offset_mins,
            ended_offset_mins,
            device,
            user_agent,
            ip,
            user_id,
        });
    }
    sessions
}

fn write_sessions(out: &mut String, sessions: &[GenSession]) {
    out.push_str("insert into sessions (id, user_id, device_type, user_agent, ip_address, started_at, ended_at) values\n");
    let n = sessions.len();
    for (i, s) in sessions.iter().enumerate() {
        let ended_sql = s
            .ended_offset_mins
            .map(ts_minus_mins)
            .unwrap_or_else(|| "NULL".into());
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{id}', '{user_id}', {device}, {ua}, {ip}::inet, {started}, {ended_sql}){sep}",
            id = s.id,
            user_id = s.user_id,
            device = q(s.device),
            ua = q(s.user_agent),
            ip = q(&s.ip),
            started = ts_minus_mins(s.started_offset_mins),
        )
        .unwrap();
    }
}

/// `reviews` — one of the two "tens of thousands of rows" tables. Iterates
/// products × a random number of reviewers per product so the total lands
/// in [10_000, 20_000] regardless of the specific RNG draws (80 products ×
/// [130, 220] reviews each = [10_400, 17_600]). Three single-column FKs:
/// user_id -> users, product_id -> products, order_id -> orders (nullable
/// "verified purchase" — when set, it's always one of *that same user's*
/// own orders, never an arbitrary order, so FK navigation from a review
/// lands somewhere semantically sensible).
fn write_reviews(
    out: &mut String,
    rng: &mut StdRng,
    users: &[GenUser],
    orders_by_user: &HashMap<Uuid, Vec<Uuid>>,
) {
    let rating_pool: [i16; 8] = [5, 5, 5, 4, 4, 3, 2, 1];
    let title_pool = [
        "Exceeded expectations",
        "Does the job",
        "Would buy again",
        "Not what I expected",
        "Solid value",
        "Mixed feelings",
        "Highly recommend",
        "Fell short",
    ];

    struct Row {
        user_id: Uuid,
        product_id: i64,
        order_id: Option<Uuid>,
        rating: i16,
        title: Option<&'static str>,
        body: Option<String>,
        verified: bool,
        created_offset_mins: u32,
    }

    let mut rows: Vec<Row> = Vec::new();
    for product_id in 1i64..=(PRODUCT_COUNT as i64) {
        let n_reviews = rng.random_range(REVIEWS_PER_PRODUCT_MIN..=REVIEWS_PER_PRODUCT_MAX);
        for _ in 0..n_reviews {
            let user = users.choose(rng).unwrap();
            let rating = *rating_pool.choose(rng).unwrap();
            let title = if rng.random_bool(0.6) {
                Some(*title_pool.choose(rng).unwrap())
            } else {
                None
            };
            let body = if rng.random_bool(0.75) {
                let p: String = Paragraph(1..3).fake_with_rng(rng);
                Some(p)
            } else {
                None
            };
            let (order_id, verified) = if rng.random_bool(0.4) {
                match orders_by_user.get(&user.id).filter(|v| !v.is_empty()) {
                    Some(user_orders) => (Some(*user_orders.choose(rng).unwrap()), true),
                    None => (None, false),
                }
            } else {
                (None, false)
            };
            let created_offset_mins = rng.random_range(10..200_000);
            rows.push(Row {
                user_id: user.id,
                product_id,
                order_id,
                rating,
                title,
                body,
                verified,
                created_offset_mins,
            });
        }
    }

    out.push_str(
        "insert into reviews \
         (user_id, product_id, order_id, rating, title, body, is_verified_purchase, created_at) values\n",
    );
    let n = rows.len();
    for (i, r) in rows.iter().enumerate() {
        let order_sql = uuid_sql(r.order_id);
        let title_sql = r.title.map(q).unwrap_or_else(|| "NULL".into());
        let body_sql = r.body.as_ref().map(|b| q(b)).unwrap_or_else(|| "NULL".into());
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{user_id}', {product_id}, {order_sql}, {rating}, {title_sql}, {body_sql}, {verified}, {created}){sep}",
            user_id = r.user_id,
            product_id = r.product_id,
            rating = r.rating,
            verified = r.verified,
            created = ts_minus_mins(r.created_offset_mins),
        )
        .unwrap();
    }
}

/// `support_tickets` — a few hundred rows, not a bulk table. Three
/// single-column FKs: user_id -> users (the customer), assigned_admin_id ->
/// users (nullable — deliberately a *second*, distinct FK column to the
/// same target table, to exercise the FK-icon/navigation logic for two
/// columns pointing at one table), order_id -> orders (nullable, and when
/// set always one of that ticket's own user's orders). Every 4th ticket
/// gets a guaranteed multi-paragraph (3-6 paragraph) description — the
/// gap-#2 "large text value" fixture — the rest get a single short
/// paragraph.
fn write_support_tickets(
    out: &mut String,
    rng: &mut StdRng,
    users: &[GenUser],
    staff_users: &[&GenUser],
    orders_by_user: &HashMap<Uuid, Vec<Uuid>>,
) {
    let statuses = ["open", "open", "in_progress", "resolved", "resolved", "closed"];
    let subjects = [
        "Order has not arrived",
        "Unable to log in",
        "Requesting a refund",
        "Charged twice for one order",
        "Question about my account",
        "Product arrived damaged",
        "How do I change my email",
        "App keeps crashing at checkout",
        "Missing item from order",
        "Need to update shipping address",
    ];

    out.push_str(
        "insert into support_tickets \
         (user_id, assigned_admin_id, order_id, subject, description, status, created_at, resolved_at) values\n",
    );
    for i in 0..SUPPORT_TICKET_COUNT {
        let user = users.choose(rng).unwrap();
        let assigned = if !staff_users.is_empty() && rng.random_bool(0.75) {
            Some(staff_users.choose(rng).unwrap().id)
        } else {
            None
        };
        let order_id = if rng.random_bool(0.5) {
            orders_by_user
                .get(&user.id)
                .filter(|v| !v.is_empty())
                .map(|v| *v.choose(rng).unwrap())
        } else {
            None
        };
        let subject = *subjects.choose(rng).unwrap();
        let description = if i % 4 == 0 {
            let paras: Vec<String> = Paragraphs(3..6).fake_with_rng(rng);
            paras.join("\n\n")
        } else {
            Paragraph(1..2).fake_with_rng(rng)
        };
        let status = *statuses.choose(rng).unwrap();
        let created_offset_mins = rng.random_range(60..300_000);
        let resolved_offset_mins = if matches!(status, "resolved" | "closed") {
            Some(rng.random_range(0..created_offset_mins))
        } else {
            None
        };

        let assigned_sql = uuid_sql(assigned);
        let order_sql = uuid_sql(order_id);
        let resolved_sql = resolved_offset_mins
            .map(ts_minus_mins)
            .unwrap_or_else(|| "NULL".into());
        let sep = if i + 1 == SUPPORT_TICKET_COUNT { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{user_id}', {assigned_sql}, {order_sql}, {subject}, {description}, {status}, {created}, {resolved_sql}){sep}",
            user_id = user.id,
            subject = q(subject),
            description = q(&description),
            status = q(status),
            created = ts_minus_mins(created_offset_mins),
        )
        .unwrap();
    }
}

/// Small, flat `gateway_response` — the common case.
fn small_gateway_response(rng: &mut StdRng) -> String {
    let gateway = *["stripe", "braintree", "adyen"].choose(rng).unwrap();
    let txn_id: u64 = rng.random_range(100_000_000..999_999_999);
    format!(r#"{{"gateway": "{gateway}", "transaction_id": "txn_{txn_id}"}}"#)
}

/// Large/deeply-nested `gateway_response` — the gap-#2 fixture, used for a
/// deterministic subset of `payments` rows (failed charges and refunds).
/// Multiple nesting levels (`risk.review`), an array of objects
/// (`attempts`), ~15-20 total keys.
fn large_gateway_response(rng: &mut StdRng) -> String {
    let gateway = *["stripe", "braintree", "adyen"].choose(rng).unwrap();
    let codes = [
        "card_declined",
        "insufficient_funds",
        "expired_card",
        "processor_error",
        "fraud_suspected",
    ];
    let txn_id: u64 = rng.random_range(100_000_000..999_999_999);
    let score = rng.random_range(40..99);
    let required = rng.random_bool(0.5);
    let country = *["US", "CA", "GB", "DE"].choose(rng).unwrap();
    let postal: u32 = rng.random_range(10000..99999);
    let procref: u32 = rng.random_range(1000..9999);
    let network = *["visa", "mastercard", "amex"].choose(rng).unwrap();
    let auth: u32 = rng.random_range(100000..999999);

    let n_attempts = rng.random_range(2..=3);
    let attempts: Vec<String> = (0..n_attempts)
        .map(|n| {
            let code = *codes.choose(rng).unwrap();
            let at_offset: u32 = rng.random_range(1..5000);
            format!(r#"{{"attempt": {}, "code": "{code}", "at_offset_mins": {at_offset}}}"#, n + 1)
        })
        .collect();

    format!(
        r#"{{"gateway": "{gateway}", "transaction_id": "txn_{txn_id}", "risk": {{"score": {score}, "flags": ["velocity", "mismatched_cvv"], "review": {{"required": {required}, "reviewer": null}}}}, "attempts": [{attempts_joined}], "billing_address": {{"country": "{country}", "postal_code": "{postal}"}}, "raw": {{"processor_ref": "ref_{procref}", "network": "{network}", "auth_code": "{auth}"}}}}"#,
        attempts_joined = attempts.join(", "),
    )
}

/// `payments` — roughly tracks `orders` volume (mostly 1 payment per
/// order): pending orders sometimes have none yet, refunded orders get a
/// second row for the refund transaction itself. Three single-column FKs:
/// order_id -> orders, processed_by_user_id -> users (nullable, a staff
/// user — set for most failed/refunded rows, rarely for succeeded ones),
/// related_event_id -> events (nullable). `gateway_response` is large/nested
/// (gap #2) for failed and refund rows, small/flat otherwise.
fn write_payments(out: &mut String, rng: &mut StdRng, orders: &[GenOrder], staff_users: &[&GenUser]) {
    struct Row {
        order_id: Uuid,
        processed_by: Option<Uuid>,
        related_event: Option<i64>,
        amount_cents: i32,
        status: &'static str,
        gateway_response: String,
        offset_mins: u32,
    }

    let mut rows: Vec<Row> = Vec::new();
    for o in orders {
        if o.status == "pending" && rng.random_bool(0.4) {
            continue; // no payment attempt recorded yet
        }
        let primary_status = match o.status {
            "completed" => *["succeeded", "succeeded", "succeeded", "failed"].choose(rng).unwrap(),
            "refunded" => "succeeded",
            "cancelled" => "failed",
            _ => *["pending", "failed"].choose(rng).unwrap(),
        };
        let gap = rng.random_range(1..2000).min(o.created_offset_mins);
        let primary_offset = o.created_offset_mins - gap;
        let processed_by = if matches!(primary_status, "failed" | "refunded")
            && !staff_users.is_empty()
            && rng.random_bool(0.5)
        {
            Some(staff_users.choose(rng).unwrap().id)
        } else {
            None
        };
        let related_event = if rng.random_bool(0.3) {
            Some(rng.random_range(1..=(EVENT_COUNT as i64)))
        } else {
            None
        };
        let gateway_response = if primary_status == "failed" {
            large_gateway_response(rng)
        } else {
            small_gateway_response(rng)
        };
        rows.push(Row {
            order_id: o.id,
            processed_by,
            related_event,
            amount_cents: o.total_cents,
            status: primary_status,
            gateway_response,
            offset_mins: primary_offset,
        });

        if o.status == "refunded" {
            let refund_gap = rng.random_range(1..1000).min(primary_offset);
            let refund_offset = primary_offset - refund_gap;
            let refund_processed_by = if !staff_users.is_empty() {
                Some(staff_users.choose(rng).unwrap().id)
            } else {
                None
            };
            rows.push(Row {
                order_id: o.id,
                processed_by: refund_processed_by,
                related_event,
                amount_cents: -o.total_cents,
                status: "refunded",
                gateway_response: large_gateway_response(rng),
                offset_mins: refund_offset,
            });
        }
    }

    out.push_str(
        "insert into payments \
         (order_id, processed_by_user_id, related_event_id, amount_cents, status, gateway_response, created_at) values\n",
    );
    let n = rows.len();
    for (i, r) in rows.iter().enumerate() {
        let processed_sql = uuid_sql(r.processed_by);
        let event_sql = int_sql(r.related_event);
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{order_id}', {processed_sql}, {event_sql}, {amount}, {status_sql}, '{gateway}'::jsonb, {created}){sep}",
            order_id = r.order_id,
            amount = r.amount_cents,
            status_sql = q(r.status),
            gateway = r.gateway_response.replace('\'', "''"),
            created = ts_minus_mins(r.offset_mins),
        )
        .unwrap();
    }
}

/// `audit_log` — the other "tens of thousands" table. All three FKs
/// (actor_user_id -> users, session_id -> sessions, event_id -> events) are
/// nullable: real audit logs have plenty of system-initiated entries with
/// no human actor, no session, and no associated event.
fn write_audit_log(out: &mut String, rng: &mut StdRng, users: &[GenUser], sessions: &[GenSession]) {
    let actions = [
        "user.login",
        "user.logout",
        "user.password_reset",
        "order.created",
        "order.status_changed",
        "order.refunded",
        "product.updated",
        "payment.processed",
        "payment.failed",
        "permission.changed",
        "export.requested",
        "admin.impersonation_started",
        "settings.updated",
        "ticket.assigned",
        "ticket.resolved",
    ];

    out.push_str("insert into audit_log (actor_user_id, session_id, event_id, action, details, occurred_at) values\n");
    for i in 0..AUDIT_LOG_COUNT {
        let actor = if rng.random_bool(0.7) {
            Some(users.choose(rng).unwrap().id)
        } else {
            None
        };
        let session = if rng.random_bool(0.4) {
            Some(sessions.choose(rng).unwrap().id)
        } else {
            None
        };
        let event = if rng.random_bool(0.5) {
            Some(rng.random_range(1..=(EVENT_COUNT as i64)))
        } else {
            None
        };
        let action = *actions.choose(rng).unwrap();
        let occurred_offset_mins = rng.random_range(1..500_000);

        let actor_sql = uuid_sql(actor);
        let session_sql = uuid_sql(session);
        let event_sql = int_sql(event);
        let sep = if i + 1 == AUDIT_LOG_COUNT { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ({actor_sql}, {session_sql}, {event_sql}, {action_sql}, '{{\"seq\": {i}}}'::jsonb, {occurred}){sep}",
            action_sql = q(action),
            occurred = ts_minus_mins(occurred_offset_mins),
        )
        .unwrap();
    }
}

/// `inventory_locations` — the composite-primary-key half of the composite-FK
/// fixture. Two warehouses of four bins each; returns the generated
/// `(warehouse_code, bin_code)` pairs so `write_inventory_counts` can pick
/// real ones.
fn write_inventory_locations(out: &mut String, rng: &mut StdRng) -> Vec<(String, String)> {
    let warehouses = ["WH1", "WH2"];
    let mut pairs = Vec::new();
    for wh in warehouses {
        for bin_n in 1..=4 {
            pairs.push((wh.to_string(), format!("A{bin_n:02}")));
        }
    }

    out.push_str("insert into inventory_locations (warehouse_code, bin_code, label, capacity) values\n");
    let n = pairs.len();
    for (i, (wh, bin)) in pairs.iter().enumerate() {
        let label = if rng.random_bool(0.7) {
            q(&format!("Aisle {bin} — {wh}"))
        } else {
            "NULL".into()
        };
        let capacity = rng.random_range(20..500);
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(out, "    ({}, {}, {label}, {capacity}){sep}", q(wh), q(bin)).unwrap();
    }
    pairs
}

/// `inventory_counts` — the composite-FK-*referencing* half: `(warehouse_code,
/// bin_code)` together reference `inventory_locations`, so the conformance
/// suite can assert those two columns carry no `key`/`references` metadata
/// (`spec/protocol.md` §5.4.1), while `product_id` (an ordinary single-column
/// FK on the same table) does. `photo` is the `bytea` fixture — populated on
/// roughly a third of rows, a few bytes of RNG output each.
fn write_inventory_counts(out: &mut String, rng: &mut StdRng, locations: &[(String, String)]) {
    out.push_str(
        "insert into inventory_counts \
         (warehouse_code, bin_code, product_id, quantity, photo, counted_at) values\n",
    );
    for i in 0..INVENTORY_COUNT_ROWS {
        let (wh, bin) = locations.choose(rng).unwrap();
        let product_id = rng.random_range(1..=(PRODUCT_COUNT as i64));
        let quantity = rng.random_range(0..2000);
        let photo = if rng.random_bool(0.3) {
            let len = rng.random_range(4..12);
            let mut bytes = vec![0u8; len];
            rng.fill(bytes.as_mut_slice());
            Some(bytes)
        } else {
            None
        };
        let counted_offset_days = rng.random_range(0..200);
        let sep = if i + 1 == INVENTORY_COUNT_ROWS { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ({}, {}, {product_id}, {quantity}, {}, {}){sep}",
            q(wh),
            q(bin),
            bytea_sql(photo.as_deref()),
            ts_minus_days(counted_offset_days),
        )
        .unwrap();
    }
}

/// `feature_flags` — deliberately excluded from the `analyze` block in
/// `main()`: the conformance fixture for a table with no planner statistics
/// (`common-values` must yield an empty list, not an error; `table-counts`
/// may read back `-1`).
fn write_feature_flags(out: &mut String, rng: &mut StdRng) {
    let keys = [
        "new_dashboard",
        "beta_checkout",
        "dark_mode_default",
        "export_v2",
        "inline_editing",
        "sibling_health_badges",
    ];
    out.push_str("insert into feature_flags (key, enabled, rollout_pct, created_at) values\n");
    let n = keys.len().min(FEATURE_FLAG_COUNT);
    for (i, key) in keys.iter().take(n).enumerate() {
        let enabled = rng.random_bool(0.6);
        let rollout = if enabled {
            format!("{}", rng.random_range(0..=100))
        } else {
            "NULL".into()
        };
        let created_days_ago = rng.random_range(1..300);
        let sep = if i + 1 == n { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ({}, {enabled}, {rollout}, {}){sep}",
            q(key),
            date_minus_days(created_days_ago),
        )
        .unwrap();
    }
}

/// Appends the `_conformance_meta` sentinel row. `checksum` hashes
/// everything generated *before* this point — informational only, see
/// `fnv1a64` — so it must stay the very last thing written.
fn write_conformance_meta(out: &mut String) {
    let checksum = format!("{:016x}", fnv1a64(out));
    let version = CONFORMANCE_VERSION.trim();
    writeln!(
        out,
        "insert into _conformance_meta (seed_version, checksum) values ({}, {});",
        q(version),
        q(&checksum),
    )
    .unwrap();
}
