# Shared filter fixtures

Machine-readable fixture sets, generated from the normative docs they
mirror (`spec/filter-dsl.md` §5, `spec/join-dsl.md` §5 and
`spec/protocol.md` §5.4.2). The docs
remain the human-readable source of truth; a change to either doc and its
fixture file ships in the same PR.

## `parser-tests.json` — frontend DSL parser (DSL text → AST)

Consumed only by the frontend's fixture runners
(`frontend/test/filter-dsl.test.ts` for the parser,
`frontend/test/filter-tokens.test.ts` for the highlighting tokenizer), since
DSL parsing exists only in the frontend. Not part of backend conformance.

Each entry in `cases`:

- `name` — the `spec/filter-dsl.md` §5 case ID (`V*`/`R*`/`A*`; A9 is
  split into its at-limit and over-limit halves).
- `input` — the DSL text fed to the parser, verbatim (R13/R14/A9's
  generated long inputs are materialized here in full).
- `aliases` — optional. A join view's table aliases in position order; the
  parser runs in join mode (`spec/filter-dsl.md` §3), so qualified names
  resolve and every condition in `expect` carries `join`. Absent means a
  single-table view.
- `expect` — the exact AST array the parser must emit
  (`spec/protocol.md` §5.4.2 conditions), compared by deep equality:
  optional fields (`logic` on the first condition, `not` when false,
  `value` for `IS [NOT] NULL`) must be *absent*, not null/false-filled.
- `expect_error` — the case must be rejected client-side. When
  `position` is present, the error's byte offset (UTF-8 bytes into
  `input`) must equal it; when absent, only the rejection itself is
  asserted (exact offsets for mid-string failures are parser-internal
  detail, pinned only where they're unambiguous).

Exactly one of `expect`/`expect_error` is present.

## `join-parser-tests.json` — frontend join parser (join text → `JoinDef`)

Consumed only by `frontend/test/join-dsl.test.ts` and
`frontend/test/join-tokens.test.ts`. Not part of backend
conformance. Top-level `catalog` maps seed-schema table names to their
column names, for unqualified names. Top-level `schemas` maps a schema name
to its tables in the same shape, for `schema.table` names; a `null` schema or
table means its tables or columns are not loaded. Cases run against both
unless `no_catalog` is `true`.

Each entry in `cases`:

- `name` — the `spec/join-dsl.md` §5 case ID.
- `input` — the join text, verbatim.
- `expect` — the exact `JoinDef` (`spec/join-dsl.md` §3), compared by deep
  equality. With it, `canonical` — the text `print(def)` must write, which
  must itself parse back to the same `JoinDef`.
- `expect_error` — the case must be rejected. `code` is a
  `spec/join-dsl.md` §4 code; `line` and `column` (1-based) are asserted
  when present; `suggest` is the closest catalog name when the message
  offers one. Message text is not pinned.

Exactly one of `expect`/`expect_error` is present.

## `filter-builder-tests.json` — backend AST validation + WHERE building

Consumed by every backend's fixture runner (reference:
`implementations/rust/core/src/db/postgres.rs`'s `filter_builder_fixtures`)
and, over HTTP, by the black-box suite (`conformance/runner/filter_dsl.rs`),
which JSON-encodes each case into a real `filter` query param.

Top-level `tables` maps each seed table a case names to its columns, each
with the Postgres `type` (`information_schema.columns.data_type`) and the
`spec/protocol.md` §5.11.2 `class`. Unit runners use it in place of a live
catalog: the class picks typed or text comparison, and the type picks the
cast target.

Each entry in `cases`:

- `name` — stable case ID.
- `table` — the seed-schema table whose live columns the case is
  validated against (`.devcontainer/db/init/01-seed.sql`); unit runners
  may substitute a static column list matching that table.
- `conditions` — the decoded filter AST (the usual input), **or** `raw` —
  a literal pre-URL-encoding `filter` param value, for cases that aren't
  a valid conditions array at all (malformed JSON, DSL text).
- `expect` — the case is valid; the resulting WHERE clause must match:
  - `where` — the fragment in the Postgres shape: double-quoted column
    identifiers, a `::text` cast on the column for a text comparison, a
    cast on the placeholder for a typed one (`$1::numeric`), no cast for
    `IS [NOT] NULL` on a typed column, `$n` placeholders numbered **from `$1` in condition
    order** (an `IN` or `BETWEEN` takes one per item). Runners with a different
    placeholder scheme (`?`, offset numbering — the Rust implementation
    itself binds limit/offset first, so it checks against `$n+2`) normalize
    before comparing; the operator spellings and parenthesization are
    normative.
  - `values` — the bind values, in placeholder order.
- `engines` (optional) — the engines whose stored values include this
  case's value (`NaN`, a ` BC` date), so the HTTP runner checks the case
  only there; SQLite is listed because it skips the value check. Absent
  means every engine.
- `expect_error` — the case must be rejected (HTTP: 400). The kind names
  *why*, and implies the stage:
  - `unknown_column` — structurally valid AST, column fails the live
    schema allow-list (builder stage).
  - `invalid_value` — the column compares typed and a value does not
    match its class's form (builder stage: it needs the column's class).
  - `malformed`, `bad_op`, `bad_logic`, `missing_value`,
    `unexpected_value`, `bad_value` (wrong value shape for the op: an
    array where a string belongs, or a bad `IN`/`BETWEEN` list),
    `missing_logic`, `unexpected_logic`, `too_many_conditions`,
    `oversize` — structural validation, rejected before any schema
    access. Error message text is
    implementation-defined (`spec/protocol.md` §2); only the rejection
    is asserted.
