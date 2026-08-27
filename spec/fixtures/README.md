# Shared filter fixtures

Two machine-readable fixture sets, generated from the normative docs they
mirror (`spec/filter-dsl.md` §5 and `spec/protocol.md` §5.4.2). The docs
remain the human-readable source of truth; a change to either doc and its
fixture file ships in the same PR.

## `parser-tests.json` — frontend DSL parser (DSL text → AST)

Consumed only by the frontend parser's fixture runner
(`tools/e2e-tests/tests/filter-parser.spec.ts`), since DSL parsing exists
only in `dbviewer.html`. Not part of backend conformance.

Each entry in `cases`:

- `name` — the `spec/filter-dsl.md` §5 case ID (`V*`/`R*`/`A*`; A9 is
  split into its at-limit and over-limit halves).
- `input` — the DSL text fed to the parser, verbatim (R13/R14/A9's
  generated long inputs are materialized here in full).
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

## `filter-builder-tests.json` — backend AST validation + WHERE building

Consumed by every backend's fixture runner (reference:
`implementations/rust/core/src/db/postgres.rs`'s `filter_builder_fixtures`)
and, over HTTP, by the black-box suite (`conformance/runner/filter_dsl.rs`),
which JSON-encodes each case into a real `filter` query param.

Each entry in `cases`:

- `name` — stable case ID.
- `table` — the seed-schema table whose live columns the case is
  validated against (`.devcontainer/db/init/01-seed.sql`); unit runners
  may substitute a static column list matching that table.
- `conditions` — the decoded filter AST (the usual input), **or** `raw` —
  a literal pre-URL-encoding `filter` param value, for cases that aren't
  a valid conditions array at all (malformed JSON, DSL text).
- `expect` — the case is valid; the resulting WHERE clause must match:
  - `where` — the fragment in the Rust implementation's normalized shape:
    double-quoted column identifiers, `::text` casts, `$n` placeholders
    numbered **from `$1` in condition order**. Runners with a different
    placeholder scheme (`?`, offset numbering — the Rust implementation
    itself binds limit/offset first, so it checks against `$n+2`) normalize
    before comparing; the operator spellings and parenthesization are
    normative.
  - `values` — the bind values, in placeholder order.
- `expect_error` — the case must be rejected (HTTP: 400). The kind names
  *why*, and implies the stage:
  - `unknown_column` — structurally valid AST, column fails the live
    schema allow-list (the only builder-stage kind).
  - `malformed`, `bad_op`, `bad_logic`, `missing_value`,
    `unexpected_value`, `missing_logic`, `unexpected_logic`,
    `too_many_conditions`, `oversize` — structural validation, rejected
    before any schema access. Error message text is
    implementation-defined (`spec/protocol.md` §2); only the rejection
    is asserted.
