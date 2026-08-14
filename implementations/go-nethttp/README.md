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

cfg := ashurbanipal.Config{Environment: "dev", EnabledFor: []string{"dev"}}
source := ashurbanipal.NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
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

## Database support

| Backend | Type | Status |
|---|---|---|
| Postgres (`PostgresSource`) | default, always compiled | Conformant — the reference implementation `spec/protocol.md` is written against; covered by the full `conformance/runner` suite. |
| SQLite (`SQLiteSource`) | opt-in via the `sqlite` build tag (`go build -tags sqlite ./...`) | Ported against `implementations/rust/core/src/db/sqlite.rs`: comments and pre-computed common-values statistics have no SQLite equivalent and degrade to omitted/empty; table counts are always the "no estimate" sentinel rather than Postgres's fast planner estimate. Not run through `conformance/runner` (that suite targets Postgres); has its own unit test suite instead (`sqlite_test.go`, no external service needed — a real on-disk file). Diverges from the Rust reference on the timeout mechanism: plain `context.WithTimeout` around `database/sql`'s `QueryContext` is sufficient with `modernc.org/sqlite` (empirically verified — see `sqlite_test.go`'s `TestSQLiteSlowQueryIsAbortedNotLeftToRun`), unlike Rust's sqlx driver, which needed a `sqlite3_progress_handler` because context cancellation there only stopped waiting, not the blocking call. See `docs/adapter-decisions.md`. |
| MySQL/MariaDB (`MySQLSource`) | opt-in via the `mysql` build tag (`go build -tags mysql ./...`) | Ported against `implementations/rust/core/src/db/mysql.rs`: pre-computed common-values statistics have no reliable cross-version equivalent and degrade to empty. Table counts and comments come from `information_schema`, same as Postgres. Detects MySQL vs. MariaDB at runtime (`SELECT VERSION()`, cached) since the two forks need different query-timeout SQL — see `docs/adapter-decisions.md` §6. Not run through `conformance/runner`; has its own unit test suite instead (`mysql_test.go`), requiring a live instance via `MYSQL_TEST_URL`/`MARIADB_TEST_URL`. |

```sh
# Postgres only (default):
go build ./...
# To also compile SQLiteSource:
go build -tags sqlite ./...
# To also compile MySQLSource:
go build -tags mysql ./...
# Everything:
go build -tags sqlite,mysql ./...
```

Swapping backends only changes which `NewXSource` constructor builds the
`DbSource` passed to `Router` — config, kill switch, filter DSL, and
frontend are identical either way:

```go
import ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"

source := ashurbanipal.NewSQLiteSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
```

```go
source := ashurbanipal.NewMySQLSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer, err := ashurbanipal.Router(cfg, source)
```

## Layout

- `config.go` — `Config`/`Limits`/`Sibling`, the fail-closed kill switch.
- `db.go` — the `DbSource` interface (the one seam to the database; route
  handlers never touch `*sql.DB`/`*sql.Tx` directly) plus the shared
  wire types.
- `postgres.go` — `PostgresSource`, the default `DbSource` implementation;
  ported line-for-line against `implementations/rust/core/src/db/postgres.rs`'s
  catalog SQL.
- `sqlite.go` (`sqlite` build tag) — `SQLiteSource`, ported against
  `implementations/rust/core/src/db/sqlite.rs`.
- `mysql.go` (`mysql` build tag) — `MySQLSource`, ported against
  `implementations/rust/core/src/db/mysql.rs`.
- `filter.go` — the filter AST's structural validation and Postgres's
  WHERE-clause builder, ported against `implementations/rust/core/src/filter.rs`
  (`sqlite.go`/`mysql.go` each carry their own dialect-specific builder).
- `siblings.go` — health fan-out via `errgroup`.
- `routes.go` — `Router(cfg, source)` and the six HTTP handlers.
- `embed.go` — the vendored `frontend/dbviewer.html`, sha256-reverified
  on every package load (see `PORTING.md`'s vendoring contract).
- `cmd/demo` — the runnable example host (Postgres only), `go run ./cmd/demo`.

## Tests

```sh
go test ./...                        # Postgres-only: fixture + kill-switch
                                      # tests always run; integration tests
                                      # skip without DATABASE_URL
go test -tags sqlite ./...           # + SQLite unit tests (no external
                                      # service needed)
go test -tags mysql ./...            # + MySQL/MariaDB unit tests (skip
                                      # without MYSQL_TEST_URL/MARIADB_TEST_URL)
go test -tags sqlite,mysql -race ./...
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
