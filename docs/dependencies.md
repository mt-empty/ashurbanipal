# Dependency pinning (v1)

Status: agreed, pre-implementation
Versions verified against crates.io as of July 2026.

## Runtime dependencies

| Crate | Req | Current | Features | Why / notes |
|-------|-----|---------|----------|-------------|
| `axum` | `0.8` | 0.8.9 | default | The one framework v1 targets (`design.md` §3.2). MSRV 1.80. |
| `sqlx` | `0.9` | 0.9.0 | `runtime-tokio`, `tls-rustls-ring-webpki`, `postgres`, `uuid`, `chrono`, `json` | Pure-Rust TLS (no OpenSSL system dep — matters for an embeddable lib). Type features cover the column types the browser must decode (uuid/timestamptz/jsonb). |
| `tokio` | `1` | 1.52.3 | `rt`, `macros` (lib needs little; the *host* brings the runtime) | Floor in practice is whatever axum/sqlx need. LTS lines: 1.47.x / 1.51.x. |
| `serde` | `1` | 1.x | `derive` | API response types + config. |
| `serde_json` | `1` | 1.x | default | Row values are rendered as JSON. |
| `toml` | `1` | 1.1.2 | default | Config parsing (`design.md` §7). Now a 1.x crate — pin `1`, not the old 0.x line. |
| `reqwest` | `0.13` | 0.13.4 | `default-features = false`, `rustls-tls`, `json` | Sibling health checks only. rustls to match sqlx (one TLS stack in the tree, no OpenSSL). |

## Deliberately absent

- **`async-trait` — not used.** Native async-fn-in-trait (stable since Rust
  1.75) covers `DbSource` because v1 never needs `dyn DbSource`: the router
  is generic (`router<S: DbSource>(config, source)`) and exactly one impl
  exists (`PgPoolSource`). If a future backend needs runtime polymorphism,
  add `async-trait` (or a `dyner`-style wrapper) *then* — it's additive.
  `design.md` §5 updated to drop the `#[async_trait]` attribute.
- **No `tower`/`tower-http` direct dep** unless a concrete need appears
  (axum re-exports what the router needs).
- **No config-framework crate** (`figment`, `config`) — one TOML file,
  `toml` + `serde` is enough.

## Dev-dependencies (demo + tests only)

| Crate | Req | Why |
|-------|-----|-----|
| `tokio` | `1`, features `rt-multi-thread`, `full` as needed | The demo/test binary owns its runtime. |
| `tracing-subscriber` | `0.3` | Demo logging. |
| `dotenvy` | `0.15` | Demo reads `DATABASE_URL` from the devcontainer env. |

## Policy

- **Caret requirements in `Cargo.toml`** (`"0.8"`, `"0.9"`, `"1"`) — this is
  a library; exact `=x.y.z` pins would force resolution conflicts on hosts.
  The table above records the *tested-against* versions.
- **`Cargo.lock` committed** — current cargo guidance is to commit lockfiles
  for libraries too (CI and contributors build what was tested; the lock is
  ignored by downstream hosts anyway).
- **MSRV: 1.80** (set by axum 0.8.9; native AFIT needs only 1.75). Declare
  via `rust-version` in `Cargo.toml`; confirm sqlx 0.9's MSRV doesn't push
  it higher at scaffold time, and CI-check it.
- **TLS stance: rustls everywhere** (sqlx + reqwest) — zero system TLS/
  OpenSSL requirements, keeping "embed the crate" from imposing host build
  dependencies.
