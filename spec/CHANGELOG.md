# Protocol changelog

This file tracks the wire-contract version only. Implementation-level changes
per published port live in each port's own `implementations/<port>/CHANGELOG.md`.

Versioning policy (`PORTING.md`'s Governance section): additive-optional
changes keep the same major version; anything behavioral or
shape-changing bumps the version and gets an entry here.

## 1 (current)

Initial protocol version — `spec/protocol.md` + `spec/openapi.yaml` as
published. There is no prior externally-observable version to bump away
from: the pre-spec reference's DSL-text filter format was never itself a
versioned wire contract, just an implementation detail, so v1 already
bakes in the JSON-AST filter representation as its baseline.

Routes added since first publication under the additive-optional policy,
all keeping v1 (they change nothing an existing caller observes — see
`spec/protocol.md` §7): §5.7 `/api/schemas`, §5.8 `/api/sources`, §5.9
`/api/tables/referenced-by`.

Error bodies (§2) changed from plain text (`text/plain`) to RFC 9457
Problem Details (`application/problem+json`), adding a stable
machine-readable `code`. This is a serialization change that would
normally bump the version, but it landed before any external consumer
existed — treated as an in-place v1 correction (see `spec/protocol.md`
§7). Implementation rollout across the reference and every port is
tracked in `docs/feature-backlog/34-rfc9457-problem-details.md`.
