# Protocol changelog

Versioning policy (`PORTING.md`'s Governance section): additive-optional
changes keep the same major version; anything behavioral or
shape-changing bumps the version and gets an entry here.

## 1 (current)

Initial protocol version — `spec/protocol.md` + `spec/openapi.yaml` as
published. There is no prior externally-observable version to bump away
from: the pre-spec reference's DSL-text filter format was never itself a
versioned wire contract, just an implementation detail, so v1 already
bakes in the JSON-AST filter representation as its baseline (see
`implementation.md` §1.4's note on this).
