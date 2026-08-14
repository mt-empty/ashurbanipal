# Shared WASM core for the filter/response logic across language ports

**Ask:** instead of every `implementations/*` port hand-reimplementing the
filter-DSL compiler and response/metadata shaping, compile that logic once
and embed it via a WASM runtime (e.g. wasmtime/wasmer bindings) in each host
language, so a bug fix or new operator lands everywhere on one version bump
instead of N synced PRs.

**Impact / constraints:**
- Scope would be narrow, not a rewrite of `DbSource`: only the pure,
  I/O-free logic is a good WASM candidate — the filter AST
  validation/operator-to-SQL-fragment compiler (`implementations/rust/core/src/filter.rs`,
  tested against `spec/filter-dsl.md`'s table) and the
  `spec/protocol.md`-shaped response/metadata JSON envelope. Everything
  else stays native per port: DB connection/pool/query execution, HTTP
  routing into the host framework, and config/kill-switch loading all
  depend on host-specific drivers and conventions that WASM can't (and
  per the `DbSource` invariant, shouldn't) absorb.
- DB I/O through WASM is possible now, just not the way that helps here:
  Fermyon Spin ships a pooled outbound-Postgres SDK for components, and
  wasmCloud has a pluggable Postgres capability provider (multiplexing
  multiple DB roles behind one interface as of its 2026-07 release);
  WasmEdge's own native driver is still in progress
  ([WasmEdge#1432](https://github.com/WasmEdge/WasmEdge/issues/1432)). But
  in both shipped cases the *runtime* brokers the connection under its own
  capability grant, not the host app's existing pool — which breaks the
  "no separate credentials, reuse what the host already has" pitch and the
  `DbSource`-is-the-only-seam invariant. Getting DB I/O into WASM this way
  means the host stops being "a library your app embeds via
  `app.merge`/mount" and becomes "a component that runs inside Spin's or
  wasmCloud's runtime" — a deployment-model change, not an implementation
  detail, and a separate decision from this one. Also note: true async I/O
  (WASI Preview 3) is still RC as of Spin 3.5 (Nov 2025), so a component
  serving concurrent DB-browsing requests today blocks per-component under
  Preview 2 semantics — a real concurrency ceiling for a multi-user web UI.
- Real cost to weigh against the dedup win, for the in-scope (pure-logic)
  version of this: every host gains a WASM runtime as a dependency (extra
  native artifact per platform, worse story on unusual targets), each port
  becomes less inspectable/idiomatic (a thin shim over a binary blob
  instead of real Go/Kotlin/TS), and some ecosystems' SCA/vuln-scanning
  tooling doesn't handle vendored WASM blobs well — friction for a tool
  whose whole pitch is being safe to embed.
- Prior art worth checking before designing the ABI: Extism (generic
  host-SDK-per-language + host-functions-as-callback pattern), OPA's
  WASM-compiled Rego SDKs (same shape, narrower domain), and DuckDB-Wasm
  (single C++ core, native FFI per language, WASM only for the
  browser/no-FFI leg — a hybrid, not WASM-everywhere). None of them solve
  introspection + async external-DB access through the boundary; this
  project would be first for that specific combination.
- Before committing to this for real: spike just the filter compiler +
  response shaper as a WASM module against one existing port (Go is
  probably the best test bed) and measure the marshaling overhead and
  binary-size hit before deciding it's worth doing everywhere.
