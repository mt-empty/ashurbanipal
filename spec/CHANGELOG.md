# Protocol changelog

This file tracks the wire-contract version only. Implementation-level changes
per published port live in each port's own `implementations/<port>/CHANGELOG.md`.

Versioning policy (`PORTING.md`'s Governance section): additive-optional
changes keep the same major version; anything behavioral or
shape-changing bumps the version and gets an entry here, except under
`spec/protocol.md` §7's alpha exception (every port pre-1.0, all changed
together), which lands in place and is still listed here.

## 1 (current)

Initial protocol version — `spec/protocol.md` + `spec/openapi.yaml` as
published. There is no prior externally-observable version to bump away
from: the pre-spec reference's DSL-text filter format was never itself a
versioned wire contract, just an implementation detail, so v1 already
bakes in the JSON-AST filter representation as its baseline.

Routes added since first publication under the additive-optional policy,
all keeping v1 (they change nothing an existing caller observes — see
`spec/protocol.md` §7): §5.7 `/api/schemas`, §5.8 `/api/sources`, §5.9
`/api/tables/referenced-by`, §5.10 `/api/tables/structure`, §5.11 `/api/tables/join`.

Every API response also carries `X-Content-Type-Options: nosniff` (§2).
Additive — a response header an existing caller can ignore — so v1 stands.

The UI route (§5.1) is sent compressed when the request accepts `gzip`,
with `Content-Encoding` and `Vary: Accept-Encoding`; the decoded body is
still the artifact byte for byte. Additive — a request without
`Accept-Encoding` gets the same uncompressed page as before — so v1
stands.

`/api/siblings` (§5.6) gains an optional `instance` object and an optional
`label` on each sibling, both host-configured opaque strings. The sibling
matching `instance` is reported healthy without a health check. Additive —
both fields are absent unless configured — so v1 stands. Sibling
configuration is never rejected: an incomplete `instance` is ignored, an
empty `label` is dropped, and duplicates are kept, each reported in an
optional `warnings` array that is absent when there is nothing to report.

Error bodies (§2) changed from plain text (`text/plain`) to RFC 9457
Problem Details (`application/problem+json`), adding a stable
machine-readable `code`. This is a serialization change that would
normally bump the version, but it landed before any external consumer
existed — treated as an in-place v1 correction (see `spec/protocol.md`
§7). Implementation rollout across the reference and every port is
tracked in `docs/feature-backlog/34-rfc9457-problem-details.md`.

`/api/schemas` (§5.7) entries changed from strings to `{ "name": … }`
objects, matching `/api/sources`, and both routes gained a required
`default`: the source or schema an absent parameter resolves to (`null`
for a schema when the connection has none). List order no longer marks the
default source. An absent `schema` on a connection with no default is now a
400 `unknown_schema` on every port. The entry-shape change is not additive;
it lands in place under §7's alpha exception, with every port, the
conformance runner, and the bundled UI changed together.

Column metadata (§5.4.1, and §5.11.4's join columns) gained `class`: the
§5.11.2 column class the server already checks `on` pairs with, omitted for a
column that cannot be joined. §5.11.2 gained the `untyped` class every port
already applied to SQLite columns with no declared type, and says that two
`enum` columns join only when their new `enum_type` field, the enumerated
type's identity, is equal. The bundled UI
now greys join pairs by `class` instead of guessing from type names. This
lands with every port, the conformance runner, and the bundled UI changed
together, under §7's alpha exception.

In the same release, `type` (§5.4.1) changed from the bare catalog data type
to the engine's full spelling: Postgres `format_type()` instead of
`information_schema.columns.data_type`, so `USER-DEFINED`, `ARRAY`,
`character varying` and `numeric` become the enum's name, `text[]`,
`character varying(20)` and `numeric(10,2)`; MySQL `COLUMN_TYPE` instead of
`DATA_TYPE`, so a boolean reads `tinyint(1)`. SQLite is unchanged. This is not
additive, and lands under the same alpha exception.

Column metadata (§5.4.1, and §5.11.4's join columns) now always carries
`class`, and the class list gained `float`, `json`, `array` and `other`: the
types that used to have no class. A column that cannot be joined is now
`float`, `json`, `array` or `other` instead of having `class` omitted, and a
domain over `json` reports `json`, so the bundled UI renders it as JSON. This
is not additive, and lands with every port, the conformance runner and the
bundled UI changed together, under §7's alpha exception.
