# Make Go's Postgres/SQLite/MySQL drivers optional, like the other four ports

> **Status:** OPEN · **Area:** ports

Discussed alongside making Postgres a symmetric, opt-in Cargo feature
(`core = ["postgres"]`, default-on) and moving `pg` to an optional peer
dependency in `implementations/node-express` — capturing the shape of the
idea and why finishing it in Go needs its own scoping.

**Ask:** `implementations/go-nethttp` already gates its SQLite and
MySQL/MariaDB backends behind `//go:build sqlite` / `//go:build mysql`
constraints (`sqlite.go`, `mysql.go`), so a default `go build` compiles in
neither `modernc.org/sqlite` nor `github.com/go-sql-driver/mysql`. Two
gaps remain versus the other four ports:

- **Postgres isn't symmetric.** `postgres.go` carries no build tag, so
  `github.com/jackc/pgx/v5` is always compiled in — there's no
  `//go:build postgres` counterpart to Rust's default-on `postgres`
  feature.
- **`go.mod` still requires every driver unconditionally.** `pgx/v5`,
  `modernc.org/sqlite`, and `go-sql-driver/mysql` are all direct
  `require`s, so `go mod download` and `go.sum` still cover the full
  driver set no matter which build tags are set (the first constraint
  below bounds how much that can improve).

Every other port now treats all three backends symmetrically as opt-in:

- **Rust** — `postgres`/`sqlite`/`mysql` are all Cargo features
  (`postgres` default-on, the other two off), each gating both the sqlx
  driver feature and the backend module itself
  (`implementations/rust/core/src/db/mod.rs`).
- **Node** — `pg`/`sqlite3`/`mysql2` are all `peerDependencies` with
  `peerDependenciesMeta.<name>.optional = true`
  (`implementations/node-express/package.json`); the host installs only
  the driver(s) it actually imports.
- **Spring** — all three JDBC drivers are `compileOnly`/`testImplementation`
  only; the host supplies its own `DataSource` bean and driver on its
  runtime classpath.
- **Flask** — `postgres`/`mysql` are `[project.optional-dependencies]`
  extras; `sqlite` is free (Python stdlib `sqlite3`, no extra dependency).

Go is the only port that still compiles one backend (Postgres) in
unconditionally and lists every driver as a hard `go.mod` require.

**Why Go needs its own scoping:** Go modules have no per-consumer "pick a
subset of dependencies" mechanism analogous to Cargo features, npm peer
deps, or Python extras — `go.mod`/`go.sum` list the full module graph
needed to build the package as it exists, and `go mod download`/`go build`
resolve whatever's reachable from the source files being compiled. The
idiomatic Go equivalent is **build tags**, which this port already uses
for SQLite and MySQL: each backend lives in its own file guarded by a
`//go:build` constraint, so a build that never passes `-tags sqlite,mysql`
never compiles `modernc.org/sqlite`/`go-sql-driver/mysql`. Finishing the
job is smaller than that first split was — the file-per-backend layout
already exists; what's left is giving `postgres.go` the same
`//go:build postgres` treatment (behind whatever default the first
constraint below settles) and dropping the drivers from `go.mod`'s hard
`require` list.

**Constraints / open questions:**
- Default build tags: decide whether an untagged `go build` should keep
  working out of the box (all three compiled in, matching today's
  behavior and the "no separate build step" pitch) or whether Postgres
  becomes the implicit default the same way it's `default = ["postgres"]`
  in Rust. Whatever's chosen needs to keep `mise run rust:demo`'s Go
  analog working with zero extra flags — CLAUDE.md-equivalent acceptance
  criterion for this port.
- `go.sum` still records checksums for every module reachable from *any*
  build-tag combination in the module, even ones a given build excludes
  from compilation — so `go mod download`/`go mod verify` cost doesn't
  shrink the way `npm install`'s does today; only compiled binary size and
  build time improve. Worth confirming this tradeoff is still worth taking
  before implementing, since it's a smaller win than the Node/Rust version
  of the same change.
- The existing `postgres.go`/`sqlite.go`/`mysql.go` split already follows
  `PORTING.md`'s per-backend file layout convention (mirroring
  `postgres.rs`/`sqlite.rs`/`mysql.rs` in Rust,
  `postgres.ts`/`sqlite.ts`/`mysql.ts` in Node); a `//go:build postgres`
  tag on `postgres.go` just extends it, no new layout.
