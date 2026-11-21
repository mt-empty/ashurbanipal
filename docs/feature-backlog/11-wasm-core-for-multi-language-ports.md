# Shared WASM core for the filter, join and response logic across language ports

> **Status:** OPEN · **Area:** ports

**Deferred (2026-11-18)** in favour of shared golden-SQL fixtures
([[59-join-builder-golden-sql-fixtures]], [[60-per-engine-filter-builder-fixtures]]).
More ports in popular languages are planned, but the likely targets
(C#/.NET, PHP, Ruby) would all need a native WASM runtime
(wasmtime-dotnet, a PHP extension, wasmtime-rb), and PHP hosting often
can't load extensions. Fixtures pin behaviour across ports without that
cost or a canonical implementation. Revisit if ports still drift despite
the fixtures, or if the per-change cost across ports becomes the main
bottleneck.

**Ask:** each `implementations/*` port hand-writes the same pure logic.
Compile that logic once to WebAssembly and embed it in each host language,
so a bug fix or new operator is written and reviewed once, not five times.

**What would move into the core.** Only pure, I/O-free logic:
- The filter AST check (`spec/protocol.md` §5.4.2), including the typed
  value check and the IN/BETWEEN operators.
- The join planner and its SQL builder (`spec/join-dsl.md`). This is the
  largest duplicated piece: about 600–1,050 lines per port, against about
  230–460 for the filter (non-test code). In Rust it is already a pure
  seam: `join::plan` takes the spec plus each table's catalog metadata and
  returns a `Plan`, and `join::build_select` turns a plan plus a `Dialect`
  into SQL text and bound parameters
  (`implementations/rust/core/src/join.rs`).
- The operator→SQL mapping for all three engines (Postgres, SQLite,
  MySQL/MariaDB), which each port carries three times over.
- Sort tie-breaking on the table's key (`tie_break_keys` and
  `order_by_clause` in `join.rs`), and the request and response shapes
  (`implementations/rust/core/src/protocol_wire.rs`).

Everything else stays native: connections, pools and query execution,
catalog queries, HTTP routing, and config/kill-switch loading. These
depend on host drivers and conventions, and the `DbSource` invariant keeps
them there.

**What drift costs today.** A cross-port change lands as one PR touching
all five ports (for example #279, #281, #283). Drift is held back by
`spec/fixtures/`, which every port tests against — including the expected
SQL per engine for the filter and join builders — and by each port's
conformance CI. So the win is less writing and review per change, not
fewer PRs to keep in sync.

**Open conflicts with current design:**
- **Peer ports.** `PORTING.md` says a port is a peer, not a lesser copy,
  and `docs/design.md` §4.2 says no implementation gets special treatment.
  A core compiled from Rust makes Rust the canonical source of the most
  complex logic. It also gives up a benefit of independent ports: separate
  implementations expose spec gaps (#283 was found this way, by a typed
  round-trip conformance test). Adopting the core needs a governance
  change, not just a build change.
- **The identifier guarantee.** In Rust, only a catalog lookup can build a
  `db::Ident`, so no unchecked name reaches SQL. Across a WASM boundary the
  host passes plain strings. The core would have to do the exact catalog
  match itself, against metadata the host supplies, and each host would
  have to pass the full live catalog, not a pre-filtered list. The
  guarantee would then rest on the core's checks plus correct host input,
  not on the host's type system.
- **Dialect quirks found by real engines.** Many fixes are engine-specific
  (MySQL zero dates, #283). Moving the dialect mapping into the core does
  not remove those; it moves where they are fixed.

**Runtime cost per host:**
- Go: wazero, pure Go, no cgo.
- Kotlin/JVM: Chicory, pure Java.
- Node: built-in `WebAssembly`. The live demo, which runs node-express in
  the browser, keeps working.
- Python: wasmtime-py, which ships native wheels per platform — the one
  current host that gains a native artifact.
- Rust: none; it links the core directly.

Shipping a vendored blob with a checksum pin is a pattern the repo already
uses for `frontend/dbviewer.html` (`PORTING.md`). Remaining costs: each
port's in-scope code becomes a thin shim over a binary, harder to read and
debug in the host language; JSON (or similar) marshaling on every request;
and some SCA/vuln-scanning tools handle vendored WASM blobs poorly —
friction for a tool whose pitch is being safe to embed.

**Out of scope: DB I/O inside WASM.** Spin and wasmCloud can broker
outbound Postgres connections, but the runtime owns the connection under
its own capability grant, not the host app's pool. That breaks the "no
extra credentials, reuse what the host has" pitch and the `DbSource`
invariant, and turns Ashurbanipal from an embedded library into a
component running inside another runtime. That is a deployment-model
decision, separate from this one. (Status of these runtimes and of WASI
Preview 3 async was last checked in 2025-11 and needs a fresh look before
it is cited.)

**Prior art:** Extism (a host SDK per language, host functions as
callbacks), OPA's WASM-compiled Rego SDKs (same shape, narrower domain),
DuckDB-Wasm (native FFI per language, WASM only where FFI is missing).

**Before committing:** decide the governance question above first, since
a "no" there makes any numbers moot. Then spike `join::plan` +
`join::build_select` + the filter check as one WASM module, embedded in
the Go port via wazero. Measure binary size, per-request marshaling time
on a large join, and how much of the Go port's `filter.go`/`join.go` the
shim actually replaces.
