-- Hand-authored SQLite conformance seed — the single-schema dialect
-- counterpart of conformance/seed/seed.sql (Postgres). NOT generated: the
-- Postgres seed's generator (tools/seed-gen) emits Postgres-only SQL, and
-- sqlx itself keeps separate hand-written tests/{postgres,mysql,sqlite}/
-- setup.sql for the same reason.
--
-- SQLite has no schema concept and no column/table comments, so the
-- multi-schema fixtures (other_schema, warehouse, cross-schema FKs) and
-- every comment are absent — the runner skips those assertions for a
-- single-schema, comment-less backend (conformance/runner/backend.rs).
-- Row counts differ on purpose. Nothing wires this file into the runner
-- yet (see the seed.mysql.sql header).
--
-- Apply with: sqlite3 <db-file> < this file
-- Idempotent: drops and recreates its own tables.

PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS _conformance_meta;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS inventory_counts;
DROP TABLE IF EXISTS inventory_locations;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS support_tickets;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS saved_reports;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS order_extra;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- schema

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  age           INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  login_count   INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT NOT NULL,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending',
  total_cents  INTEGER NOT NULL,
  discount_pct REAL,
  created_at   TEXT NOT NULL
);

CREATE TABLE order_extra (
  order_id     INTEGER PRIMARY KEY REFERENCES orders(id),
  gift_message TEXT,
  is_gift      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       REAL NOT NULL,
  weight_kg   REAL,
  in_stock    INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_on  TEXT NOT NULL
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  is_test     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  device_type TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_id   INTEGER REFERENCES orders(id),
  rating     INTEGER NOT NULL,
  title      TEXT,
  body       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE support_tickets (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  assigned_admin_id INTEGER REFERENCES users(id),
  order_id          INTEGER REFERENCES orders(id),
  subject           TEXT NOT NULL,
  description       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  occurred_at   TEXT NOT NULL
);

-- Deliberately zero rows (an empty-table UI state).
CREATE TABLE saved_reports (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  is_public  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Composite primary key — inventory_counts' (warehouse_code, bin_code) FK
-- references this pair together (spec/protocol.md §5.4.1).
CREATE TABLE inventory_locations (
  warehouse_code TEXT NOT NULL,
  bin_code       TEXT NOT NULL,
  label          TEXT,
  capacity       INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (warehouse_code, bin_code)
);

CREATE TABLE inventory_counts (
  id             INTEGER PRIMARY KEY,
  warehouse_code TEXT NOT NULL,
  bin_code       TEXT NOT NULL,
  product_id     INTEGER REFERENCES products(id),
  quantity       INTEGER NOT NULL,
  counted_at     TEXT NOT NULL,
  FOREIGN KEY (warehouse_code, bin_code)
    REFERENCES inventory_locations(warehouse_code, bin_code)
);

-- SQLite has no cardinality catalog, so table-counts is always -1 and
-- common-values always empty regardless of ANALYZE — feature_flags stays
-- the "no statistics" fixture by nature, not by being skipped here.
CREATE TABLE feature_flags (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  rollout_pct INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE _conformance_meta (
  seed_version TEXT NOT NULL,
  dialect      TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- data
-- Deterministic: every value is a pure function of the row number `n`.
-- Counts match seed.mysql.sql — 50 users (exactly 6 with a NULL
-- last_login_at), 120 orders (40 completed, pending a small minority),
-- >=100 products and events, one product with sku 'TOYS-1001'.

INSERT INTO users (id, email, full_name, age, is_active, login_count, metadata, last_login_at, created_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
SELECT
  n,
  printf('user%02d@example.test', n),
  printf('User Number %02d', n),
  CASE WHEN n % 10 = 0 THEN NULL ELSE 18 + (n % 55) END,
  CASE WHEN n % 5 = 0 THEN 0 ELSE 1 END,
  n * 7,
  '{"role":"' || (CASE n % 3 WHEN 0 THEN 'admin' WHEN 1 THEN 'user' ELSE 'support' END) || '"}',
  CASE WHEN n <= 6 THEN NULL ELSE datetime('2026-07-19 00:00:00', '-' || n || ' hours') END,
  datetime('2026-07-19 00:00:00', '-' || n || ' days')
FROM seq;

INSERT INTO orders (id, user_id, status, total_cents, discount_pct, created_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  ((n - 1) % 50) + 1,
  CASE
    WHEN n % 3 = 0 THEN 'completed'
    WHEN n <= 25 THEN 'pending'
    WHEN n % 4 = 1 THEN 'cancelled'
    ELSE 'refunded'
  END,
  300 + n * 37,
  CASE WHEN n % 3 = 0 THEN round((n % 40) + 0.5, 2) ELSE NULL END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours')
FROM seq;

INSERT INTO order_extra (order_id, gift_message, is_gift, created_at)
WITH RECURSIVE seq(n) AS (SELECT 3 UNION ALL SELECT n + 3 FROM seq WHERE n < 60)
SELECT n, CASE WHEN n % 6 = 0 THEN 'Enjoy!' ELSE NULL END, CASE WHEN n % 6 = 0 THEN 1 ELSE 0 END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours')
FROM seq;

INSERT INTO products (id, sku, name, category, price, weight_kg, in_stock, description, created_on)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  CASE WHEN n = 1 THEN 'TOYS-1001' ELSE printf('SKU-%05d', n) END,
  printf('Product %d', n),
  CASE WHEN n = 1 THEN 'toys'
       ELSE (CASE n % 5 WHEN 0 THEN 'electronics' WHEN 1 THEN 'books' WHEN 2 THEN 'home' WHEN 3 THEN 'toys' ELSE 'apparel' END)
  END,
  round(5 + n * 1.37, 2),
  CASE WHEN n % 9 = 0 THEN NULL ELSE round(0.1 + (n % 15), 2) END,
  CASE WHEN n = 1 THEN 1 WHEN n % 4 = 0 THEN 0 ELSE 1 END,
  CASE WHEN n % 2 = 0 THEN printf('Description for product %d', n) ELSE NULL END,
  date('2026-07-19', '-' || n || ' days')
FROM seq;

INSERT INTO events (id, user_id, event_type, payload, occurred_at, is_test)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  CASE WHEN n % 8 = 0 THEN NULL ELSE ((n - 1) % 50) + 1 END,
  CASE n % 4 WHEN 0 THEN 'page_view' WHEN 1 THEN 'click' WHEN 2 THEN 'purchase' ELSE 'error' END,
  printf('{"n":%d}', n),
  datetime('2026-07-19 00:00:00', '-' || n || ' minutes'),
  CASE WHEN n % 20 = 0 THEN 1 ELSE 0 END
FROM seq;

INSERT INTO sessions (id, user_id, device_type, started_at, ended_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
SELECT
  n,
  ((n - 1) % 50) + 1,
  CASE n % 3 WHEN 0 THEN 'desktop' WHEN 1 THEN 'mobile' ELSE 'tablet' END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours'),
  CASE WHEN n % 5 = 0 THEN NULL ELSE datetime('2026-07-19 00:00:00', '-' || (n - 1) || ' hours') END
FROM seq;

INSERT INTO reviews (id, user_id, product_id, order_id, rating, title, body, created_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 40)
SELECT
  n,
  ((n - 1) % 50) + 1,
  ((n - 1) % 120) + 1,
  CASE WHEN n % 4 = 0 THEN ((n - 1) % 120) + 1 ELSE NULL END,
  1 + (n % 5),
  CASE WHEN n % 3 = 0 THEN printf('Review %d', n) ELSE NULL END,
  CASE WHEN n % 2 = 0 THEN printf('Body text for review %d', n) ELSE NULL END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours')
FROM seq;

INSERT INTO support_tickets (id, user_id, assigned_admin_id, order_id, subject, description, status, created_at, resolved_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25)
SELECT
  n,
  ((n - 1) % 50) + 1,
  CASE WHEN n % 3 = 0 THEN ((n - 1) % 50) + 1 ELSE NULL END,
  CASE WHEN n % 2 = 0 THEN ((n - 1) % 120) + 1 ELSE NULL END,
  printf('Subject for ticket %d', n),
  printf('Full description body for support ticket number %d.', n),
  CASE n % 4 WHEN 0 THEN 'open' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'resolved' ELSE 'closed' END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours'),
  CASE WHEN n % 4 IN (2, 3) THEN datetime('2026-07-19 00:00:00', '-' || (n - 1) || ' hours') ELSE NULL END
FROM seq;

INSERT INTO payments (id, order_id, amount_cents, status, created_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
SELECT
  n,
  ((n - 1) % 120) + 1,
  300 + n * 37,
  CASE n % 3 WHEN 0 THEN 'pending' WHEN 1 THEN 'succeeded' ELSE 'failed' END,
  datetime('2026-07-19 00:00:00', '-' || n || ' hours')
FROM seq;

INSERT INTO audit_log (id, actor_user_id, action, occurred_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 40)
SELECT
  n,
  CASE WHEN n % 5 = 0 THEN NULL ELSE ((n - 1) % 50) + 1 END,
  CASE n % 3 WHEN 0 THEN 'user.login' WHEN 1 THEN 'order.created' ELSE 'settings.updated' END,
  datetime('2026-07-19 00:00:00', '-' || n || ' minutes')
FROM seq;

INSERT INTO inventory_locations (warehouse_code, bin_code, label, capacity) VALUES
  ('WH1', 'A01', 'Aisle A01 - WH1', 120),
  ('WH1', 'A02', NULL, 200),
  ('WH1', 'A03', 'Aisle A03 - WH1', 90),
  ('WH1', 'A04', NULL, 300),
  ('WH2', 'A01', 'Aisle A01 - WH2', 150),
  ('WH2', 'A02', 'Aisle A02 - WH2', 80),
  ('WH2', 'A03', NULL, 260),
  ('WH2', 'A04', 'Aisle A04 - WH2', 110);

INSERT INTO inventory_counts (id, warehouse_code, bin_code, product_id, quantity, counted_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
SELECT
  n,
  CASE WHEN n % 2 = 0 THEN 'WH1' ELSE 'WH2' END,
  'A0' || (1 + (n % 4)),
  CASE WHEN n % 7 = 0 THEN NULL ELSE ((n - 1) % 120) + 1 END,
  n * 13,
  date('2026-07-19', '-' || n || ' days')
FROM seq;

INSERT INTO feature_flags (key, enabled, rollout_pct, created_at) VALUES
  ('new_dashboard',         1, 50,   date('2026-07-19', '-30 days')),
  ('beta_checkout',         0, NULL, date('2026-07-19', '-25 days')),
  ('dark_mode_default',     1, 100,  date('2026-07-19', '-20 days')),
  ('export_v2',             0, NULL, date('2026-07-19', '-15 days')),
  ('inline_editing',        1, 10,   date('2026-07-19', '-10 days')),
  ('sibling_health_badges', 1, 75,   date('2026-07-19', '-5 days'));

ANALYZE;

INSERT INTO _conformance_meta (seed_version, dialect, checksum, generated_at)
VALUES ('4', 'sqlite', 'sqlite-hand-authored', '2026-07-19 00:00:00');
