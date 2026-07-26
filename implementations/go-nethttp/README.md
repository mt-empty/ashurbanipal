# ashurbanipal (go-nethttp)

A `net/http`-native Go port of [Ashurbanipal](../../readme.md) — implements
the same `spec/protocol.md` + `spec/openapi.yaml` contract as the Rust
reference and the Kotlin/Spring Boot starter, targeting the standard
library's `http.Handler` directly rather than any specific router, so it
mounts into a plain `net/http.ServeMux`, Chi, or anything else that speaks
`http.Handler`.

Not tagged/released — this module is only "published" in the sense of
being a well-formed Go module in this repository. Once a release tag
exists, the intended usage is:

```sh
go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@vX.Y.Z
```

```go
import ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"

viewer, err := ashurbanipal.Router(ashurbanipal.Config{
	Environment: "dev",
	EnabledFor:  []string{"dev"},
}, db) // *sql.DB the host already constructed
if err != nil {
	// a production-like EnabledFor value fails here, at construction —
	// fail-closed, mirroring Config::from_toml in the Rust reference.
	log.Fatal(err)
}
mux.Handle("/", viewer) // or nest it under any net/http-compatible router
```

`Config{}` (the zero value) is disabled by construction: `EnabledFor` is
`nil`, so no environment ever matches. A host that forgets to configure
anything gets a 404'd viewer, never one silently enabled with defaults.

## Layout

- `config.go` — `Config`/`Limits`/`Sibling`, the fail-closed kill switch.
- `catalog.go` — the one seam to `*sql.DB`; ported line-for-line against
  `implementations/rust/src/db.rs`'s catalog SQL.
- `filter.go` — the filter AST's structural validation and WHERE-clause
  builder, ported against `implementations/rust/src/filter.rs`.
- `siblings.go` — health fan-out via `errgroup`.
- `routes.go` — `Router(cfg, db)` and the six HTTP handlers.
- `embed.go` — the vendored `frontend/dbviewer.html`, sha256-reverified
  on every package load (see `PORTING.md`'s vendoring contract).
- `cmd/demo` — the runnable example host, `go run ./cmd/demo`.

## Tests

```sh
go test ./...              # fixture + kill-switch tests always run;
                            # integration tests skip without DATABASE_URL
go test -race ./...
```

Fixture tests (`filter_fixture_test.go`) consume
`spec/fixtures/filter-builder-tests.json` directly from the repo root.
Integration tests (`integration_test.go`) need `DATABASE_URL` pointed at a
Postgres instance with `conformance/seed/seed.sql` applied (the
devcontainer sets this up automatically).

## Conformance

```sh
go run ./cmd/demo &
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/report.sh
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:4000/__ashurbanipal bash ../../conformance/runner/schema-check.sh
```

## CSP note

Per `PORTING.md`, this port takes the same option the Rust reference and
Spring Boot starter take: it sets no `Content-Security-Policy` header and
injects no nonce. A host running under a strict CSP forbidding inline
scripts must extend it for the mount path before the UI's inline
`<script type="module">` will execute client-side.
