# Conformance seed: dialect parity for MySQL/SQLite

> **Status:** OPEN · **Area:** conformance, infra

**Problem:** the conformance seed exists in three files, and only one is
checked. `tools/seed-gen` generates `conformance/seed/seed.sql`, and
`tools/check-seed-sync.sh` byte-checks it. `seed.mysql.sql` and
`seed.sqlite.sql` are hand-written, and nothing compares them to
`seed.sql`; both file headers say so.

The two hand-written seeds lack four foreign keys that `seed.sql` has:
`payments.processed_by_user_id`, `payments.related_event_id`,
`audit_log.session_id` and `audit_log.event_id`.

**Why it matters:** MySQL, MariaDB and SQLite run conformance and the
`test-e2e-backend` e2e job against a thinner fixture than Postgres. On
Postgres, `/api/tables/referenced-by?table=users` (`spec/protocol.md`
§5.9) returns 9 entries: 8 in `public` plus `warehouse.shipment_events`.
MySQL and SQLite return 7. So
`referenced_by::lists_incoming_fk_constraints_with_explicit_column_pairs`
(`conformance/runner/referenced_by.rs`) checks only three FKs that all
seeds share, never the full list or its length. Any feature built on the
FK graph inherits this limit, for example
[[36-referenced-by-row-presence-indicator]].

**Options:**
- Teach `tools/seed-gen` to emit the MySQL and SQLite seeds too, and
  byte-check all three. Most work, best result: the seeds can't drift.
  The SQLite half is partly built. `cargo run -- sqlite`
  (`generate_sqlite` in `tools/seed-gen/src/main.rs`) already emits all
  four missing FKs for `mise run rust:demo-sqlite`. It lacks
  `saved_reports`, `page_hits`, `typed_samples`, `_conformance_meta` and
  the `active_users` view, which the runner needs.
- Keep the hand-written files, and add a CI check that compares the FK
  graph (referencing table.column → referenced table.column, plus primary
  keys) across the three seeds. Cheaper; catches drift without generator
  work.
- Add the four FKs to the hand-written seeds by hand once, and add the
  check above to keep them in line.

**Constraints:**
- Adding the four FKs changes no table, so `conformance/seed/VERSION`,
  `SEEDED_TABLES` (`conformance/runner/tables.rs`) and
  `tools/e2e-tests/tests/table-listing.spec.ts` stay as they are. Adding a
  table touches all three (story 57 C6).
- The seeds differ on purpose in other ways. `seed.sqlite.sql` has no
  `other_schema` or `warehouse`, and row counts differ. Parity here means
  the FK graph within the schemas each seed defines, not identical files.
