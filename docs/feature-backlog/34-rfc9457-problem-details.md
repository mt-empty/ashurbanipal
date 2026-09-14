# RFC 9457 problem+json error bodies

> **Status:** DONE · **Area:** spec, ports, frontend, conformance · **Ref:** migrated in one pass across spec + all five ports + frontend + conformance (no production consumers existed, so the incremental dual-format rollout below was skipped)

`spec/protocol.md` §2 and `spec/openapi.yaml` specify error responses as
`application/problem+json` (RFC 9457 Problem Details, the current revision
of RFC 7807) with a stable machine-readable `code` member — `text/plain`
is no longer offered. `spec/protocol.md` §7 records why this
serialization change did not bump the protocol version (no external
consumer existed).

**Why:** the previous contract — plain text, "clients MUST NOT parse it" —
gave the frontend no way to tell *why* a 400 happened. A drill-in to a
table the role can't read (Postgres 42501 / MySQL 1142, mapped to 400)
was indistinguishable from an unknown table or a malformed filter, so the
UI could only ever show a generic error. `code` fixes that. Surfaced while
planning [[14-incoming-fk-references]], whose cross-schema/privilege
failure modes are exactly the ones the frontend needs to name.

**Defined `code` values** (`spec/protocol.md` §2): `unknown_source`,
`unknown_schema`, `unknown_table`, `unknown_column`, `invalid_filter`,
`invalid_parameter`, `not_readable` (400); `database_error`,
`query_timeout` (500). Open set — new codes are additive.

**Shipped:**
- **Rust reference** — `DbError::NotAllowed` (`implementations/rust/core/src/db/mod.rs`)
  now carries a `NotAllowedKind` (`Source`/`Schema`/`Table`/`Column`/`NotReadable`),
  and a `DbError::problem()` maps every variant to `(status, code)`, shared
  by both adapters. The axum and actix `ApiError` bridges emit
  `application/problem+json` with the version header. Axum's and Actix's
  own `Query<T>` extractor rejections (missing/duplicate/malformed
  parameters) previously bypassed `ApiError` entirely with their own
  plain-text bodies — both adapters now route those through the same
  problem+json path too (a wrapper `FromRequestParts` impl in axum,
  `web::QueryConfig::error_handler` in actix), since that rejection
  happens inside the framework's own request-dispatch layer, not the
  pre-dispatch server rejections `PORTING.md`'s "Request-boundary
  rejections" section carves out as an accepted per-port gap.
  `query_timeout` is populated only where detection was a one-line
  addition to code that already extracts the driver error code
  (Postgres SQLSTATE `57014` in `map_select_denied`); see the `§6` note
  in `docs/adapter-decisions.md` for why every other engine/port still
  reports a timeout as `database_error`.
- **go-nethttp / node-express / flask-python / spring-boot** — same kind-
  tagging in each port's own error type (`NotAllowedError.Kind` in Go,
  a `code` field in Node's error classes, `NotAllowedKind` in Flask and
  Spring), each port's error writer emitting problem+json. Spring Boot's
  migration also fixed a pre-existing bug where an unknown filter column
  raised `FilterException` (`invalid_filter`) instead of `NotAllowedException`
  (`unknown_column`), inconsistent with its own MySQL/SQLite sources and
  with every other port.
- **Frontend** — `frontend/src/core/api.ts` exposes an `ApiError` class
  with a `.code` field parsed from the problem+json body (falling back to
  a generic message on an unrecognized/absent code, per spec). The one
  caller that branches on it: `bootstrap/controller.ts`'s `loadData` shows
  "you don't have access to `<table>`" for `not_readable` instead of the
  server's implementation-defined title text (`docs/ui-guidelines.md` R9).
- **Conformance** — `assert.rs` gained `assert_problem_code`, an opt-in
  helper on top of the status-only tier that also pins the
  `application/problem+json` content-type and the `code` field. Used at
  one representative site per reachable code across `table_data.rs`,
  `schemas.rs`, `sources.rs`, and `filter_dsl.rs`; `not_readable` stays
  covered only by the existing port-local `table_listing_privileges*`
  tests (it needs a restricted role, which the shared seed doesn't have).
  `schema-check.sh` (schemathesis) now enforces the
  `application/problem+json` content-type against all seven adapters.
