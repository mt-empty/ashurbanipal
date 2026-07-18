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

use std::collections::HashSet;
use std::fmt::Write as _;

use fake::faker::company::en::Buzzword;
use fake::faker::internet::en::{IPv4, SafeEmail};
use fake::faker::lorem::en::Paragraph;
use fake::faker::name::en::Name;
use fake::rand::rngs::StdRng;
use fake::rand::seq::IndexedRandom;
use fake::rand::{Rng, SeedableRng};
use fake::Fake;
use uuid::Uuid;

const SEED: u64 = 20260716;
const USER_COUNT: usize = 50;
const PRODUCT_COUNT: usize = 80;
const EVENT_COUNT: usize = 400;
const SESSION_COUNT: usize = 120;

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

fn main() {
    let mut rng = StdRng::seed_from_u64(SEED);
    let mut out = String::new();

    write_header(&mut out);
    write_schema(&mut out);

    let users = gen_users(&mut rng);
    write_users(&mut out, &users);

    write_orders(&mut out, &mut rng, &users);
    write_products(&mut out, &mut rng);
    write_events(&mut out, &mut rng, &users);
    write_sessions(&mut out, &mut rng, &users);

    out.push_str(
        "\n-- pg_class.reltuples is only populated by ANALYZE/autovacuum; without this,\n\
         -- a freshly seeded dev db shows -1 via /table-counts until autovacuum runs.\n\
         analyze users;\nanalyze orders;\nanalyze products;\nanalyze events;\nanalyze sessions;\n",
    );

    print!("{out}");
}

fn write_header(out: &mut String) {
    out.push_str(
        "-- GENERATED FILE — do not hand-edit.\n\
         -- Source: tools/seed-gen (`cargo run` from that directory, output redirected here).\n\
         -- Realistic, varied data for exercising the Ashurbanipal DB browser during manual\n\
         -- frontend development: five tables spanning uuid/bigint-identity PKs, enums,\n\
         -- numeric/real, arrays, inet, date/timestamptz, varchar(n), and NULLs throughout.\n\
         -- Idempotent (drops first) so it can be re-run against a live dev db.\n\n\
         create extension if not exists pgcrypto;\n\n\
         drop table if exists sessions cascade;\n\
         drop table if exists events cascade;\n\
         drop table if exists orders cascade;\n\
         drop table if exists products cascade;\n\
         drop table if exists users cascade;\n\
         drop type if exists order_status cascade;\n\
         drop type if exists product_category cascade;\n\n",
    );
}

fn write_schema(out: &mut String) {
    out.push_str(
        "create type order_status as enum ('pending', 'completed', 'cancelled', 'refunded');\n\
         create type product_category as enum ('electronics', 'books', 'home', 'toys', 'apparel');\n\n\
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
         );\n\n",
    );
    // A deliberately partial set of `comment on` statements — most
    // tables/columns are left uncommented so the demo also exercises the
    // no-comment (absent `title=`) path, not just the happy path.
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
         'Login sessions, one row per device/browser session.';\n\n",
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
    last_login_offset_mins: Option<u32>,
    created_offset_days: u32,
}

fn gen_users(rng: &mut StdRng) -> Vec<GenUser> {
    let roles = ["admin", "user", "user", "user", "support", "moderator"];
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
        let role = *roles.choose(rng).unwrap();
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
            Some(mins) => format!("now() - interval '{mins} minutes'"),
            None => "NULL".into(),
        };
        let sep = if i + 1 == users.len() { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{id}', {email}, {name}, {age}, {active}, {logins}, '{meta}'::jsonb, {last_login}, now() - interval '{created} days'){sep}",
            id = u.id,
            email = q(&u.email),
            name = q(&u.full_name),
            active = u.is_active,
            logins = u.login_count,
            meta = u.metadata.replace('\'', "''"),
            created = u.created_offset_days,
        )
        .unwrap();
    }
}

fn write_orders(out: &mut String, rng: &mut StdRng, users: &[GenUser]) {
    let statuses = [
        "pending",
        "completed",
        "completed",
        "completed",
        "cancelled",
        "refunded",
    ];
    let tag_pool = ["priority", "gift-wrap", "backorder", "fragile", "international"];
    let mut rows = Vec::new();

    for u in users {
        let n_orders = rng.random_range(0..9);
        for _ in 0..n_orders {
            let status = *statuses.choose(rng).unwrap();
            let total_cents = rng.random_range(300..25_000);
            let discount = if rng.random_bool(0.3) {
                Some(rng.random_range(200..4000) as f64 / 100.0)
            } else {
                None
            };
            let tags = if rng.random_bool(0.3) {
                let n = rng.random_range(1..=2);
                let chosen: Vec<&str> = tag_pool
                    .choose_multiple(rng, n)
                    .copied()
                    .collect();
                Some(chosen)
            } else {
                None
            };
            let n_items = rng.random_range(1..=4);
            let items: Vec<String> = (0..n_items)
                .map(|_| {
                    format!(
                        r#"{{"sku": "WIDGET-{}", "qty": {}}}"#,
                        rng.random_range(1000..9999),
                        rng.random_range(1..4)
                    )
                })
                .collect();
            let created_offset_mins = rng.random_range(60..288_000);
            rows.push((u.id, status, total_cents, discount, tags, items, created_offset_mins));
        }
    }

    out.push_str("insert into orders (user_id, status, total_cents, discount_pct, tags, line_items, created_at) values\n");
    for (i, (user_id, status, total_cents, discount, tags, items, created_mins)) in
        rows.iter().enumerate()
    {
        let discount_sql = discount
            .map(|d| format!("{d:.2}"))
            .unwrap_or_else(|| "NULL".into());
        let tags_sql = match tags {
            Some(t) => format!(
                "array[{}]",
                t.iter().map(|s| q(s)).collect::<Vec<_>>().join(", ")
            ),
            None => "NULL".into(),
        };
        let items_sql = format!("'[{}]'::jsonb", items.join(", "));
        let sep = if i + 1 == rows.len() { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{user_id}', '{status}', {total_cents}, {discount_sql}, {tags_sql}, {items_sql}, now() - interval '{created_mins} minutes'){sep}"
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
            "    ({sku}, {name}, {category}, {price:.2}, {weight_sql}, {in_stock}, {desc_sql}, current_date - {created_days_ago}){sep}",
            sku = q(&sku),
            name = q(&name),
            category = q(category),
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
            "    ({user_sql}, {et}, {payload}, {ip_sql}::inet, {duration_sql}, now() - interval '{occurred_mins_ago} minutes', {is_test}){sep}",
            et = q(event_type),
            ip_sql = q(&ip),
        )
        .unwrap();
    }
}

fn write_sessions(out: &mut String, rng: &mut StdRng, users: &[GenUser]) {
    let devices = ["desktop", "mobile", "tablet", "bot"];
    let user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "curl/8.7.1",
    ];

    out.push_str("insert into sessions (user_id, device_type, user_agent, ip_address, started_at, ended_at) values\n");
    for i in 0..SESSION_COUNT {
        let user_id = users.choose(rng).unwrap().id;
        let device = *devices.choose(rng).unwrap();
        let ua = *user_agents.choose(rng).unwrap();
        let ip: String = IPv4().fake_with_rng(rng);
        // started far enough in the past that a plausible session length still lands >= 0.
        let started_mins_ago = rng.random_range(300..90_000);
        let ended_sql = if rng.random_bool(0.2) {
            "NULL".to_string()
        } else {
            let length = rng.random_range(1..180);
            format!(
                "now() - interval '{} minutes'",
                started_mins_ago - length
            )
        };
        let sep = if i + 1 == SESSION_COUNT { ";\n\n" } else { ",\n" };
        write!(
            out,
            "    ('{user_id}', {device}, {ua}, {ip}::inet, now() - interval '{started_mins_ago} minutes', {ended_sql}){sep}",
            device = q(device),
            ua = q(ua),
            ip = q(&ip),
        )
        .unwrap();
    }
}
