# Make Go's Postgres/SQLite/MySQL drivers optional, like the other four ports

> **Status:** OPEN · **Area:** ports

**Ask:** the Go port should compile in no database driver the host did not
choose. The other four ports already work that way:

- **Rust** — `postgres`/`sqlite`/`mysql` Cargo features (`postgres`
  default-on), each gating the sqlx driver feature and the backend module
  (`implementations/rust/core/Cargo.toml`).
- **Node** — `pg`/`sqlite3`/`mysql2` are optional `peerDependencies`
  (`implementations/node-express/package.json`).
- **Spring** — no driver ships; the host supplies its `DataSource`.
- **Flask** — `postgres`/`mysql` extras; SQLite uses the stdlib.

**Where Go stands.** The host opens the `*sql.DB` with its own driver and
passes it in (`implementations/go-nethttp/README.md`). The library imports
a driver package only to read error codes:

- `postgres.go` has no build tag and imports `github.com/jackc/pgx/v5/pgconn`
  for `*pgconn.PgError` (the timeout detector in `init`, and
  `mapSelectDenied`). So every build compiles in pgconn.
- `mysql.go` sits behind `//go:build mysql` and imports
  `github.com/go-sql-driver/mysql` for `*mysql.MySQLError` (the timeout
  detector, and `mapSelectDeniedMySQL`).
- `sqlite.go` sits behind `//go:build sqlite` but imports no driver at all.
  `modernc.org/sqlite` is only imported by tests and `cmd/demo`.

**Fix for Postgres:** match the error by behaviour, not by type —
`errors.As` into a local `interface{ SQLState() string }`. pgx's
`*pgconn.PgError` has that method, so behaviour stays the same and the
library drops its pgx import with no build tag and no change to an
untagged `go build`. A `//go:build postgres` tag would need a default
that breaks either untagged builds or symmetry; the interface needs
neither. One catch: `mapSelectDenied` puts `pgErr.Message` in a filter
error's detail. Through the interface only `Error()` is left, which adds
the severity and `(SQLSTATE …)`; trim it or accept the longer text.

**MySQL keeps its tag.** `*mysql.MySQLError` has only `Error()` and
`Is()`, no accessor for `Number` or `SQLState`, so there is no interface
to match on.

**Open questions:**
- `go.mod` still requires all three drivers, because tests and `cmd/demo`
  live in the same module. Check with a scratch host module what
  `go mod tidy` actually adds to the host's `go.mod`/`go.sum` before doing
  any module surgery: module graph pruning may already leave test-only
  and demo-only modules out. Moving `cmd/demo` into its own module is the
  next step only if it does not.
- `mise run go:demo` (`go run ./cmd/demo`) must keep working with no extra
  flags.
