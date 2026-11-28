# Partitioned tables: browse the parent and keep its relationships

> **Status:** OPEN · **Area:** spec, ports, conformance, frontend, docs

Postgres partitioned tables (`relkind = 'p'`) are left out of the table
list, the allow-list and foreign-key metadata. A user cannot open the
parent, and a foreign key that points at it disappears with no message.

## 1. The ask

- List a partitioned parent as a browsable table, alongside its partitions,
  which stay listed as ordinary tables.
- Report each foreign key that targets or comes from a partitioned table
  once, not once per partition.
- Keep the §5.2 allow-list and the §5.2 listing in agreement, as they are
  today.

## 2. Why it is excluded today

- No recorded decision. `relkind = 'r'` was in the first scaffold commit
  (`25b42a3c`, 2026-07-16), a hard-coded `public`-schema table listing with
  no stated reason. Later work kept it for consistency: the allow-list and
  foreign-key gates were made to match the listing.
- The foreign-key code already handles partition copies on its own:
  `conparentid = 0` drops the copy Postgres puts on each partition, and the
  `structure` query's `not exists` clause drops the per-target-partition
  copies of a foreign key that points at a partitioned table. Neither needs
  the parent to be hidden.
- `docs/adapter-decisions.md` §5.4.1 drops a foreign key whose target is a
  partitioned parent, so a child table's reference to it is lost silently.
- `docs/feature-backlog/25-list-views-and-materialized-views.md` §7 asks the
  same question and leaves it open.

## 3. What the other tools do

Checked against the source of DBeaver and DBFlux (research, 2026-11-27).

- **DBeaver** lists a partitioned parent in the navigator. Its partitions
  sit in a "Partitions" folder under the parent. Partitions are also
  addressable in the schema. It has no partition-aware foreign-key dedup
  that I could find.
- **DBFlux** lists parents and partitions as flat `BASE TABLE` entries
  (`crates/dbflux_driver_postgres/src/driver.rs:3054-3057`). It has no
  Partitions view for Postgres (`crates/dbflux_driver_postgres/README.md:88`).
  Its schema-wide foreign-key list is unfiltered, so partition clones may
  show as duplicates. I inferred this and did not run it.

Neither tool documents a deliberate exclusion of partitioned tables.

## 4. Where

- **Spec** `spec/protocol.md` §5.2 (table listing and allow-list) and §5.9
  (referenced-by), plus the §5.4.1 foreign-key gate.
- **Postgres ports** (Rust, Go, Node, Flask, Spring): the `relkind = 'r'`
  predicate in the table listing, the allow-list, `key_metadata`,
  `referenced_by` and `structure`. Add `'p'` and the `conparentid = 0` rule
  consistently.
- **Inheritance-parent rules**: `pg_inherits` lists partitions too, so the
  [inheritance parents](../adapter-decisions.md#53--54--55--inheritance-parents-postgres)
  checks already apply to a partitioned parent. The summed row estimate and
  the `inherited = true` statistics row are right for it. The key rule is
  not: Postgres enforces a partitioned parent's primary key and unique
  indexes across its partitions, so `relkind = 'p'` must keep its keys.
- **MySQL/MariaDB and SQLite**: no change. InnoDB has no foreign keys on
  partitioned tables (`docs/adapter-decisions.md` §5.9).
- **Frontend**: the table list shows the parent with its partitions beneath
  it, as DBeaver does, or flat, as DBFlux does. Decide which.
- **Tests**: the port-local partition tests already exist (Rust
  `referenced_by_partitioning.rs`, `structure_partitioning.rs`; Go
  `referenced_by_partitioning_test.go`), see
  `docs/feature-backlog/57-testing-environment-gaps.md`. Extend them to
  cover a browsable parent.

## 5. Open questions

- Show partitions nested under the parent (DBeaver), or flat (DBFlux)?
- Does a query on the parent go through the same path as an ordinary table
  (Postgres reads partitioned parents directly), with no extra gate?
- Keep the foreign-key gate that drops targets it cannot open, and
  apply it to the parent as well?

## 6. Done when

- A partitioned parent appears in the table list and opens in the grid.
- A foreign key to or from a partitioned table appears once, with the
  correct target.
- Every Postgres port passes the shared conformance suite and its
  partition tests.
