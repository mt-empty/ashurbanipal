# A column that's both PK and FK never reports `references`

**Status:** fixed — commit `07070db` (PR #36). `references` is now
populated for a PK+FK column regardless of what `key` reports, and
`spec/protocol.md` §5.4.1 specifies it (`key: "pk"` wins the single-value
field; `references` is present whenever the column is a foreign key). Rest
kept as history.

**Bug, not a feature ask** — filed here because it's cross-port and
low-severity rather than a single-PR fix; captured for a deliberate pass
later rather than an unplanned edit to five files under the same code
shape.

**What:** a column that is simultaneously its own table's primary key
*and* a foreign key into another table — the classic 1:1 "detail table"
shape, e.g. `order_extra.order_id integer primary key references
orders(id)` instead of a separate auto-increment ID — is reported by the
API as `key: "pk"` with `references` omitted, even though the FK
relationship is real and would normally be surfaced.

**Where:** every backend's column-classification step checks "is this
the primary key?" first and returns early, so it never also checks the
FK map for the same column:

- `implementations/rust/src/db/postgres.rs:412-418` (the origin — same
  shape almost certainly exists in `sqlite.rs`/`mysql.rs` too, not
  independently confirmed at the time of writing)
- `implementations/go-nethttp/postgres.go:457-458`, `sqlite.go:361-362`,
  `mysql.go:586-587`
- Kotlin/Spring and Node/Flask backends were not individually confirmed
  to have the exact same code shape at review time, but inherit it by
  construction (every port is a line-for-line catalog-query port of the
  Rust reference, `PORTING.md` hardening item 7) — check when picking
  this up rather than assuming.

**Impact:** cosmetic/informational only. No wrong data, no security
issue — `dbviewer.html` just doesn't show "this column also references
`orders.id`" for a column shaped this way, the one place a user might
actually want to see it (a 1:1 detail table is exactly the case where
the FK relationship isn't obvious from the column name alone). Not
something a bugbot-style bug hunt should re-flag as new each time; came
up as a shared observation across independent review passes of the Go,
Flask, Kotlin, and Node ports in August 2026 — inherited unchanged from
the Rust reference, not a regression introduced by any one port.

**Fix shape:** in each backend's column-building step, don't short-
circuit on PK — check both maps and report `key: "pk"` with the FK's
`references` populated when a column is in both. Needs a decision on
wire shape first: `spec/protocol.md`'s `ColumnInfo.key` is currently a
single `"pk" | "fk" | null` enum, not a set — is `references` alongside
`key: "pk"` sufficiently unambiguous, or does the protocol need a
`key: ["pk", "fk"]` shape (a breaking wire change) instead? That's a
protocol question, not a per-port implementation detail, and should be
settled once for `spec/protocol.md` before any backend changes — fixing
one port ad hoc would just create new cross-port drift.

**Where to verify a fix:** a live PK+FK column fixture doesn't currently
exist in `.devcontainer/db/init/01-seed.sql`/`conformance/seed/seed.sql`
— add one (`tools/seed-gen`) so this is actually exercised by
`conformance/runner` rather than caught only by manual testing per port.
