# Conformance seed

`seed.sql` is generated output, not hand-written — see `tools/seed-gen`
(the same generator that produces `.devcontainer/db/init/01-seed.sql`; the
two files are identical, just checked in at two paths for two audiences:
the devcontainer's own init scripts, and any conformance runner —
including a port's — that doesn't have a Rust toolchain).

## Applying it

```sh
psql "$YOUR_DSN" -f conformance/seed/seed.sql
```

Idempotent: it drops and recreates every table it owns, so it's safe to
run against a database that already has an older copy of the seed (or
none at all). It does not touch tables outside its own set.

`conformance/runner` applies this automatically when
`ASHURBANIPAL_CONFORMANCE_SEED_DSN` is set (see the runner's own docs).
When that variable is unset, the runner instead expects the target
database to already carry this seed and fails fast if it can't confirm
that — see "Sentinel" below.

## Regenerating

Never hand-edit `seed.sql`. Change `tools/seed-gen/src/main.rs`, then:

```sh
cd tools/seed-gen
cargo run > ../../conformance/seed/seed.sql
cargo run > ../../.devcontainer/db/init/01-seed.sql   # keep both in sync
```

Deterministic (fixed RNG seed): regenerating without source changes
produces byte-identical output.

## Sentinel: `_conformance_meta`

The seed ends with a `_conformance_meta` table (one row: `seed_version`,
`dialect`, an informational `checksum`, `generated_at`). It's an ordinary
base table in the connection's default resolved schema — reachable over
the regular protocol, no special access needed — so the runner can
confirm a target is running *this* seed (not stale or absent data) with a
plain `GET {mount}/api/tables/data?table=_conformance_meta` call, even
against an external implementation it never spawned or connected to
directly.

`seed_version` is checked against `conformance/seed/VERSION` — the single
source of truth both `tools/seed-gen` (embeds it into the sentinel row)
and `conformance/runner` (compares against it) read. Bump `VERSION`
whenever a schema/data change would invalidate fixtures written against
the previous seed shape, and regenerate.

`dialect` (one of `postgres` / `mysql` / `sqlite`) is what each seed file
declares itself to be — the Postgres generator hardcodes `postgres`, the
hand-authored `seed.mysql.sql` / `seed.sqlite.sql` their own. The runner
reads it from the same sentinel call and uses it to pick which engine's
expectations to assert (`conformance/runner/backend.rs`), so
`ASHURBANIPAL_CONFORMANCE_BACKEND` is only a fallback for a seed that
predates the column.

## What the seed exercises

Ten original tables (`users`, `orders`, `products`, `events`, `sessions`,
`reviews`, `support_tickets`, `payments`, `audit_log`, `saved_reports`)
plus tables and a second schema added for conformance coverage:

- **`inventory_locations`** / **`inventory_counts`** — composite primary
  key / composite foreign key (`(warehouse_code, bin_code)`): asserts
  those two columns carry no `key`/`references` metadata at all
  (`spec/protocol.md` §5.4.1), while `inventory_counts.product_id`, an
  ordinary single-column FK on the same table, does. `inventory_counts`
  also carries the `bytea` fixture (`photo`).
- **`feature_flags`** — deliberately excluded from the seed's `analyze`
  pass: no planner statistics exist for it, so `common-values` must
  return an empty list rather than an error, and `table-counts` may read
  back `-1` for it.
- **`other_schema.decoy_items`** — a second Postgres schema with its own
  table, so `current_schema()`-scoping (`spec/protocol.md` §6) is
  falsifiable: `decoy_items` must never appear in `/api/tables`, and
  requesting it directly must 400 like any other unknown table.
- **`warehouse`** — a third schema (`carriers`, `shipments`,
  `shipment_events`) modeling a fulfillment subsystem, added for richer
  multi-schema coverage and two cross-schema FK shapes:
  `shipments.order_id` is a lone, required FK into `public.orders`;
  `shipment_events` carries both a same-schema FK (`shipment_id` ->
  `warehouse.shipments`) and a nullable cross-schema one
  (`handled_by_user_id` -> `public.users`) on the same table, so a
  key-metadata query that only follows same-schema FKs can't pass this
  fixture by coincidence.

Also present: table/column comments (partial, both commented and
uncommented tables/columns exist on purpose), `jsonb`, `uuid`,
`timestamptz`, `numeric`, and tables well over any page-size limit
(`audit_log`: 30,000 rows; `reviews`: 10,000+) for limit-clamping and
pagination coverage.
