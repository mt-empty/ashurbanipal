# Make Go's Postgres/SQLite/MySQL drivers optional, like the other four ports

**Status:** discussed 2026-08-16, alongside making Postgres a symmetric,
opt-in Cargo feature (`core = ["postgres"]`, default-on) and moving `pg` to
an optional peer dependency in `implementations/node-express`. Not designed,
not scheduled — capturing the shape of the idea and why it's a bigger job
in Go than it was in the other four ports.

**Ask:** today `implementations/go-nethttp/go.mod` requires
`github.com/jackc/pgx/v5`, `modernc.org/sqlite`, and
`github.com/go-sql-driver/mysql` unconditionally — there is no opt-out.
Every consumer of the Go port pays for all three drivers (including
`modernc.org/sqlite`'s cgo-free but still nontrivial compiled-in SQLite
engine) regardless of which single backend they actually use. Every other
port now treats all three backends symmetrically as opt-in:

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

Go is the one port where none of this exists yet.

**Why Go can't just copy the same fix:** Go modules have no per-consumer
"pick a subset of dependencies" mechanism analogous to Cargo features, npm
peer deps, or Python extras — `go.mod`/`go.sum` list the full module graph
needed to build the package as it exists, and `go mod download`/`go build`
resolve whatever's reachable from the source files being compiled. The
idiomatic Go equivalent is **build tags**: split each backend's
implementation into its own file guarded by a `//go:build postgres` (etc.)
constraint, so a build that never passes `-tags sqlite,mysql` never even
sees `modernc.org/sqlite`/`go-sql-driver/mysql` in its compiled package set.
That's a real restructuring of `implementations/go-nethttp/db/` (or
wherever the per-backend files live today), not a one-line manifest edit —
worth scoping as its own piece of work rather than bundled into whichever
PR made the other four ports symmetric.

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
- Whatever file split this produces should stay consistent with
  `PORTING.md`'s existing per-backend file layout convention (mirroring
  `postgres.rs`/`sqlite.rs`/`mysql.rs` in Rust,
  `postgres.ts`/`sqlite.ts`/`mysql.ts` in Node) rather than inventing a
  new one just for Go.
