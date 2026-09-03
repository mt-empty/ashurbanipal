-- Hand-authored MySQL 8 / MariaDB 11 conformance seed — the dialect
-- counterpart of conformance/seed/seed.sql (Postgres). NOT generated: the
-- Postgres seed's generator (tools/seed-gen) emits Postgres-only SQL, and
-- sqlx itself keeps separate hand-written tests/{postgres,mysql,sqlite}/
-- setup.sql for the same reason. Keep the table set, column names, comment
-- placement and the conformance-relevant fixtures (composite PK/FK, the
-- never-analyzed feature_flags table, the other_schema decoy) in step with
-- seed.sql; row counts differ on purpose. Nothing wires this file into the
-- conformance runner yet — the per-backend expected-value layer and a CI
-- job that would enforce parity against seed.sql are still to come, so
-- treat the "keep in step" note above as the only guard for now.
--
-- Apply with: mysql --host=H --port=P --user=U --password=PW DB < this file
-- Idempotent: drops and recreates its own tables (and the other_schema db).

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS `_conformance_meta`;
DROP TABLE IF EXISTS `feature_flags`;
DROP TABLE IF EXISTS `inventory_counts`;
DROP TABLE IF EXISTS `inventory_locations`;
DROP TABLE IF EXISTS `audit_log`;
DROP TABLE IF EXISTS `payments`;
DROP TABLE IF EXISTS `support_tickets`;
DROP TABLE IF EXISTS `reviews`;
DROP TABLE IF EXISTS `saved_reports`;
DROP TABLE IF EXISTS `sessions`;
DROP TABLE IF EXISTS `events`;
DROP TABLE IF EXISTS `order_extra`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `users`;
-- Defensive: leftovers from ad-hoc probing must not pollute the exact
-- table-list assertion.
DROP TABLE IF EXISTS `widget`;
DROP TABLE IF EXISTS `bin`;
SET FOREIGN_KEY_CHECKS = 1;

-- The §6 current-schema-scoping fixture: a second database with one table
-- that must never appear in the default schema's /api/tables.
DROP DATABASE IF EXISTS `other_schema`;
CREATE DATABASE `other_schema`;
CREATE TABLE `other_schema`.`decoy_items` (
  `id`    bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `label` text NOT NULL
);
INSERT INTO `other_schema`.`decoy_items` (`label`) VALUES ('decoy-1'), ('decoy-2');

-- ---------------------------------------------------------------- schema

CREATE TABLE `users` (
  `id`            bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `email`         varchar(200) NOT NULL UNIQUE,
  `full_name`     text NOT NULL,
  `age`           smallint,
  `is_active`     boolean NOT NULL DEFAULT TRUE,
  `login_count`   int NOT NULL DEFAULT 0,
  `metadata`      json NOT NULL,
  `last_login_at` datetime,
  `created_at`    datetime NOT NULL
) COMMENT = 'Registered application users.';

CREATE TABLE `orders` (
  `id`           bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`      bigint NOT NULL COMMENT 'The user who placed this order.',
  `status`       varchar(20) NOT NULL DEFAULT 'pending',
  `total_cents`  int NOT NULL,
  `discount_pct` decimal(5,2) COMMENT 'Percentage discount applied at checkout, if any.',
  `created_at`   datetime NOT NULL,
  CONSTRAINT `orders_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) COMMENT = 'Customer orders placed against the product catalog.';

CREATE TABLE `order_extra` (
  `order_id`     bigint NOT NULL PRIMARY KEY,
  `gift_message` text,
  `is_gift`      boolean NOT NULL DEFAULT FALSE,
  `created_at`   datetime NOT NULL,
  CONSTRAINT `order_extra_order_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
);

CREATE TABLE `products` (
  `id`          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sku`         varchar(20) NOT NULL UNIQUE,
  `name`        text NOT NULL,
  `category`    varchar(20) NOT NULL,
  `price`       decimal(10,2) NOT NULL,
  `weight_kg`   float,
  `in_stock`    boolean NOT NULL DEFAULT TRUE,
  `description` text,
  `created_on`  date NOT NULL
);

CREATE TABLE `events` (
  `id`          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`     bigint,
  `event_type`  varchar(40) NOT NULL,
  `payload`     json NOT NULL,
  `occurred_at` datetime NOT NULL,
  `is_test`     boolean NOT NULL DEFAULT FALSE,
  CONSTRAINT `events_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
);

CREATE TABLE `sessions` (
  `id`          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`     bigint NOT NULL,
  `device_type` varchar(20) NOT NULL,
  `started_at`  datetime NOT NULL,
  `ended_at`    datetime,
  CONSTRAINT `sessions_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) COMMENT = 'Login sessions, one row per device/browser session.';

CREATE TABLE `reviews` (
  `id`         bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`    bigint NOT NULL,
  `product_id` bigint NOT NULL,
  `order_id`   bigint,
  `rating`     smallint NOT NULL,
  `title`      text,
  `body`       text,
  `created_at` datetime NOT NULL,
  CONSTRAINT `reviews_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `reviews_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `reviews_order_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
) COMMENT = 'Product reviews left by users, optionally tied to a verified order.';

CREATE TABLE `support_tickets` (
  `id`                bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`           bigint NOT NULL,
  `assigned_admin_id` bigint,
  `order_id`          bigint,
  `subject`           text NOT NULL,
  `description`       text NOT NULL COMMENT 'Full ticket body as submitted by the customer.',
  `status`            varchar(20) NOT NULL DEFAULT 'open',
  `created_at`        datetime NOT NULL,
  `resolved_at`       datetime,
  CONSTRAINT `tickets_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `tickets_admin_id_fk` FOREIGN KEY (`assigned_admin_id`) REFERENCES `users` (`id`),
  CONSTRAINT `tickets_order_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
) COMMENT = 'Customer support tickets, optionally assigned to a staff user.';

CREATE TABLE `payments` (
  `id`           bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id`     bigint NOT NULL,
  `amount_cents` int NOT NULL,
  `status`       varchar(20) NOT NULL DEFAULT 'pending',
  `created_at`   datetime NOT NULL,
  CONSTRAINT `payments_order_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
);

CREATE TABLE `audit_log` (
  `id`            bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `actor_user_id` bigint,
  `action`        varchar(60) NOT NULL,
  `occurred_at`   datetime NOT NULL,
  CONSTRAINT `audit_log_actor_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`)
);

-- Deliberately zero rows (an empty-table UI state).
CREATE TABLE `saved_reports` (
  `id`         bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name`       text NOT NULL,
  `is_public`  boolean NOT NULL DEFAULT FALSE,
  `created_at` datetime NOT NULL
);

-- Composite primary key — inventory_counts' (warehouse_code, bin_code) FK
-- references this pair together, the "composite FKs omit key/references
-- metadata entirely" fixture (spec/protocol.md §5.4.1).
CREATE TABLE `inventory_locations` (
  `warehouse_code` varchar(10) NOT NULL,
  `bin_code`       varchar(10) NOT NULL,
  `label`          text,
  `capacity`       int NOT NULL DEFAULT 100,
  PRIMARY KEY (`warehouse_code`, `bin_code`)
);

CREATE TABLE `inventory_counts` (
  `id`             bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `warehouse_code` varchar(10) NOT NULL,
  `bin_code`       varchar(10) NOT NULL,
  `product_id`     bigint,
  `quantity`       int NOT NULL,
  `counted_at`     datetime NOT NULL,
  CONSTRAINT `inv_counts_product_fk` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `inv_counts_loc_fk` FOREIGN KEY (`warehouse_code`, `bin_code`)
    REFERENCES `inventory_locations` (`warehouse_code`, `bin_code`)
);

-- Deliberately never ANALYZEd (see the ANALYZE TABLE block below) — the
-- empty-common-values / -1-approx_rows fixture.
CREATE TABLE `feature_flags` (
  `id`          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `key`         varchar(60) NOT NULL UNIQUE,
  `enabled`     boolean NOT NULL DEFAULT TRUE,
  `rollout_pct` smallint,
  `created_at`  datetime NOT NULL
);

CREATE TABLE `_conformance_meta` (
  `seed_version` varchar(20) NOT NULL,
  `dialect`      varchar(20) NOT NULL,
  `checksum`     varchar(64) NOT NULL,
  `generated_at` datetime NOT NULL
) COMMENT = 'Conformance-suite sentinel row; not part of the application schema.';

-- ---------------------------------------------------------------- data
-- Deterministic: every value is a pure function of the row number `n`, no
-- RNG. Counts chosen so the runner's fixtures hold — 50 users (exactly 6
-- with a NULL last_login_at), 120 orders (40 completed, the rest not,
-- pending a small minority), >=100 products and events for the page-size
-- and limit-clamp cases, one product with sku 'TOYS-1001'.

INSERT INTO `users` (`id`, `email`, `full_name`, `age`, `is_active`, `login_count`, `metadata`, `last_login_at`, `created_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
SELECT
  n,
  -- Zero-padded so byte order (what the runner's descending-sort test
  -- expects) and MySQL's collation order agree.
  CONCAT('user', LPAD(n, 2, '0'), '@example.test'),
  CONCAT('User Number ', LPAD(n, 2, '0')),
  IF(n % 10 = 0, NULL, 18 + (n MOD 55)),
  n % 5 <> 0,
  n * 7,
  JSON_OBJECT('role', ELT(1 + (n MOD 3), 'admin', 'user', 'support')),
  IF(n <= 6, NULL, TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n DAY
FROM seq;

INSERT INTO `orders` (`id`, `user_id`, `status`, `total_cents`, `discount_pct`, `created_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  ((n - 1) MOD 50) + 1,
  CASE
    WHEN n % 3 = 0 THEN 'completed'
    WHEN n <= 25 THEN 'pending'
    WHEN n % 4 = 1 THEN 'cancelled'
    ELSE 'refunded'
  END,
  300 + n * 37,
  IF(n % 3 = 0, ROUND((n MOD 40) + 0.5, 2), NULL),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR
FROM seq;

INSERT INTO `order_extra` (`order_id`, `gift_message`, `is_gift`, `created_at`)
WITH RECURSIVE seq (n) AS (SELECT 3 UNION ALL SELECT n + 3 FROM seq WHERE n < 60)
SELECT n, IF(n % 6 = 0, 'Enjoy!', NULL), n % 6 = 0, TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR
FROM seq;

INSERT INTO `products` (`id`, `sku`, `name`, `category`, `price`, `weight_kg`, `in_stock`, `description`, `created_on`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  IF(n = 1, 'TOYS-1001', CONCAT('SKU-', LPAD(n, 5, '0'))),
  CONCAT('Product ', n),
  IF(n = 1, 'toys', ELT(1 + (n MOD 5), 'electronics', 'books', 'home', 'toys', 'apparel')),
  ROUND(5 + n * 1.37, 2),
  IF(n % 9 = 0, NULL, ROUND(0.1 + (n MOD 15), 2)),
  IF(n = 1, TRUE, n % 4 <> 0),
  IF(n % 2 = 0, CONCAT('Description for product ', n), NULL),
  DATE('2026-07-19') - INTERVAL n DAY
FROM seq;

INSERT INTO `events` (`id`, `user_id`, `event_type`, `payload`, `occurred_at`, `is_test`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT
  n,
  IF(n % 8 = 0, NULL, ((n - 1) MOD 50) + 1),
  ELT(1 + (n MOD 4), 'page_view', 'click', 'purchase', 'error'),
  JSON_OBJECT('n', n),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n MINUTE,
  n % 20 = 0
FROM seq;

INSERT INTO `sessions` (`id`, `user_id`, `device_type`, `started_at`, `ended_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
SELECT
  n,
  ((n - 1) MOD 50) + 1,
  ELT(1 + (n MOD 3), 'desktop', 'mobile', 'tablet'),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR,
  IF(n % 5 = 0, NULL, TIMESTAMP('2026-07-19 00:00:00') - INTERVAL (n - 1) HOUR)
FROM seq;

INSERT INTO `reviews` (`id`, `user_id`, `product_id`, `order_id`, `rating`, `title`, `body`, `created_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 40)
SELECT
  n,
  ((n - 1) MOD 50) + 1,
  ((n - 1) MOD 120) + 1,
  IF(n % 4 = 0, ((n - 1) MOD 120) + 1, NULL),
  1 + (n MOD 5),
  IF(n % 3 = 0, CONCAT('Review ', n), NULL),
  IF(n % 2 = 0, CONCAT('Body text for review ', n), NULL),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR
FROM seq;

INSERT INTO `support_tickets` (`id`, `user_id`, `assigned_admin_id`, `order_id`, `subject`, `description`, `status`, `created_at`, `resolved_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25)
SELECT
  n,
  ((n - 1) MOD 50) + 1,
  IF(n % 3 = 0, ((n - 1) MOD 50) + 1, NULL),
  IF(n % 2 = 0, ((n - 1) MOD 120) + 1, NULL),
  CONCAT('Subject for ticket ', n),
  CONCAT('Full description body for support ticket number ', n, '.'),
  ELT(1 + (n MOD 4), 'open', 'in_progress', 'resolved', 'closed'),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR,
  IF(n % 4 IN (2, 3), TIMESTAMP('2026-07-19 00:00:00') - INTERVAL (n - 1) HOUR, NULL)
FROM seq;

INSERT INTO `payments` (`id`, `order_id`, `amount_cents`, `status`, `created_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
SELECT
  n,
  ((n - 1) MOD 120) + 1,
  300 + n * 37,
  ELT(1 + (n MOD 3), 'pending', 'succeeded', 'failed'),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n HOUR
FROM seq;

INSERT INTO `audit_log` (`id`, `actor_user_id`, `action`, `occurred_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 40)
SELECT
  n,
  IF(n % 5 = 0, NULL, ((n - 1) MOD 50) + 1),
  ELT(1 + (n MOD 3), 'user.login', 'order.created', 'settings.updated'),
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n MINUTE
FROM seq;

INSERT INTO `inventory_locations` (`warehouse_code`, `bin_code`, `label`, `capacity`)
VALUES
  ('WH1', 'A01', 'Aisle A01 — WH1', 120),
  ('WH1', 'A02', NULL, 200),
  ('WH1', 'A03', 'Aisle A03 — WH1', 90),
  ('WH1', 'A04', NULL, 300),
  ('WH2', 'A01', 'Aisle A01 — WH2', 150),
  ('WH2', 'A02', 'Aisle A02 — WH2', 80),
  ('WH2', 'A03', NULL, 260),
  ('WH2', 'A04', 'Aisle A04 — WH2', 110);

INSERT INTO `inventory_counts` (`id`, `warehouse_code`, `bin_code`, `product_id`, `quantity`, `counted_at`)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
SELECT
  n,
  IF(n % 2 = 0, 'WH1', 'WH2'),
  CONCAT('A0', 1 + (n MOD 4)),
  IF(n % 7 = 0, NULL, ((n - 1) MOD 120) + 1),
  n * 13,
  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL n DAY
FROM seq;

INSERT INTO `feature_flags` (`key`, `enabled`, `rollout_pct`, `created_at`)
VALUES
  ('new_dashboard',         TRUE,  50,   TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 30 DAY),
  ('beta_checkout',         FALSE, NULL, TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 25 DAY),
  ('dark_mode_default',     TRUE,  100,  TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 20 DAY),
  ('export_v2',             FALSE, NULL, TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 15 DAY),
  ('inline_editing',        TRUE,  10,   TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 10 DAY),
  ('sibling_health_badges', TRUE,  75,   TIMESTAMP('2026-07-19 00:00:00') - INTERVAL 5 DAY);

-- MySQL/MariaDB: ANALYZE TABLE refreshes information_schema.tables.table_rows
-- (InnoDB's estimate). feature_flags is left out on purpose so its estimate
-- stays NULL -> mapped to -1 by mysql.rs (the §5.3 "never analyzed" case).
ANALYZE TABLE `users`, `orders`, `order_extra`, `products`, `events`, `sessions`,
  `reviews`, `support_tickets`, `payments`, `audit_log`, `saved_reports`,
  `inventory_locations`, `inventory_counts`;

INSERT INTO `_conformance_meta` (`seed_version`, `dialect`, `checksum`, `generated_at`)
VALUES ('4', 'mysql', 'mysql-hand-authored', TIMESTAMP('2026-07-19 00:00:00'));
