# RFC 9457 problem+json error bodies

> **Status:** OPEN · **Area:** spec, ports, frontend, conformance

**Done:** `spec/protocol.md` §2 and `spec/openapi.yaml` now specify error
responses as `application/problem+json` (RFC 9457 Problem Details, the
current revision of RFC 7807) with a stable machine-readable `code`
member. `spec/protocol.md` §7 records why this serialization change did
not bump the protocol version (no external consumer existed). This story
tracks the implementation rollout.

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

**Remaining work:**
- **Rust reference** — `DbError` (`implementations/rust/core/src/db/mod.rs`)
  gains the discriminant needed to pick a `code` (today `NotAllowed`
  alone covers source/schema/table/column/permission); the axum and
  actix `ApiError` bridges emit a problem+json body with the version
  header, replacing the `(StatusCode, String)` responses. Split
  `query_timeout` out of the generic `Sqlx` → 500 path (§6).
- **go-nethttp / node-express / flask-python / spring-boot** — same
  change in each port's error mapper (`errors.go` / `errors.ts` /
  `db/__init__.py` error classes / `@ExceptionHandler` methods) and its
  `writeError`/equivalent.
- **Frontend** — `frontend/src/core/api.ts` currently does
  `throw new Error(await resp.text())`. Parse problem+json, expose `code`,
  and let callers (the filter UI, FK/referenced-by drill-in) branch —
  e.g. a `not_readable` drill-in shows "you don't have access to that
  table" instead of a raw string. `docs/ui-guidelines.md` R9 (every async
  action surfaces a meaningful error) is the driver.
- **Conformance** — `conformance/runner/assert.rs`'s `assert_status`
  deliberately checks status code only, "never body text". Add an
  opt-in body assertion for `code`, and cover it in each route's module
  (at least the 400 paths in `table_data.rs`, `schemas.rs`, `sources.rs`,
  `referenced_by.rs`). `conformance/runner/schema-check.sh` (schemathesis)
  will start enforcing the `application/problem+json` content-type once
  the servers emit it — until every port is migrated, that leg is red for
  the lagging ports.
- **Docs** — `PORTING.md` error-handling section; each port README if it
  documents the error shape.

**Rollout:** because `spec/openapi.yaml` already declares problem+json,
`conformance:schema-test` flags every not-yet-migrated port's error
responses. Either migrate the Rust reference first and accept the four
ports' schema-test leg being red until they follow (consistent with the
[[14-incoming-fk-references]] "accept a brief red window" call), or hold
the openapi error-response flip on a branch until all five are done.
