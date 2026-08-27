# Publishing checklist

Status (2026-08-27): all six packaged ports are live on their registries.
**Go is the only port not yet published** — it needs its first tag (see below).

This doc governs *distribution* — whether a port's artifact can leave this repo
and install from a public registry. `PORTING.md` governs *correctness*
(conformance, hardening) before a port is listed in `readme.md`. They're
separate gates.

## What's published

| Port | Package / coordinate | Registry | Latest | Tag prefix | Publish workflow |
|---|---|---|---|---|---|
| Rust core | `ashurbanipal` | crates.io | 0.2.1 | `core-v*` | `rust-core-publish.yml` |
| Rust / Axum | `ashurbanipal-axum` | crates.io | 0.2.1 | `axum-v*` | `rust-axum-publish.yml` |
| Rust / Actix-web | `ashurbanipal-actix-web` | crates.io | 0.2.1 | `actix-web-v*` | `rust-actix-web-publish.yml` |
| Node / Express | `ashurbanipal-node-express` | npm | 0.1.1 | `node-v*` | `node-express-publish.yml` |
| Python / Flask | `ashurbanipal-flask` | PyPI | 0.1.1 | `flask-v*` | `flask-python-publish.yml` |
| Spring Boot | `io.github.mt-empty:ashurbanipal-spring-boot-starter` | Maven Central | 0.1.1 | `spring-v*` | `spring-boot-starter-publish.yml` |
| Go / net-http | `github.com/mt-empty/ashurbanipal/implementations/go-nethttp` | proxy.golang.org | — (unpublished) | `implementations/go-nethttp/v*` | none — tag only |

Auth is fully configured for all six:

- **crates.io, npm, PyPI** — OIDC trusted publishing, no stored token. The three
  Rust crates share one `crates-io-publish` GitHub Environment.
- **Maven Central** — `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` +
  `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE` secrets; the `maven-central-publish`
  Environment has a required reviewer before the irreversible deploy.

Every registry publish is effectively irreversible — yank / deprecate only, and
Maven Central is fully immutable. Treat a pushed release tag as final.

## Cutting a release

Versions are per-port and independent — there is no repo-wide version. For each
port:

1. Bump `version` in the port's manifest, on `main`:
   - Rust: `implementations/rust/<crate>/Cargo.toml` (+ `Cargo.lock`)
   - Node: `implementations/node-express/package.json`
   - Flask: `implementations/flask-python/pyproject.toml`
   - Spring: `implementations/spring-boot-starter/build.gradle.kts`
2. Commit to `main`.
3. Tag that commit `<prefix>-vX.Y.Z`, matching the manifest version exactly.
4. Push the tag. The publish workflow runs build + test + conformance, asserts
   the tag is on `main` and equals the manifest version, then publishes.

The three Rust crates version independently but have moved in lockstep so far
(`ashurbanipal-axum` 0.1.0 was published pre-core-extraction and can't reuse that
number, which forced the shared 0.2.x line). Keep bumping them together unless one
genuinely needs to move alone.

## Go — first publish

No registry integration needed; "publishing" is just the tag. Note the
subdirectory-module path prefix — a short `go-v*` tag would never resolve for
`go get`:

```sh
git tag implementations/go-nethttp/vX.Y.Z && git push --tags
```

`proxy.golang.org` indexes on the first `go get`. Then replace the `@vX.Y.Z`
placeholders in `implementations/go-nethttp/README.md` and `readme.md` with the
real version.

## Open items

- **Frontend artifact — not released standalone.** `dbviewer.html` ships only
  embedded in a port. Each port pins the canonical `frontend/dbviewer.html` at a
  commit and re-hashes its vendored copy in its own CI (`PORTING.md` vendoring
  section); there is no separate GitHub Release or `frontend-v*` tag.
- **`readme.md` drift.** The Spring coordinate there reads `io.github.mtempty`
  (missing hyphen — the published groupId is `io.github.mt-empty`) and shows an
  `X.Y.Z` placeholder; update both to the real coordinate and version.
- **Stale tag.** `rust-v0.1.0` predates the `rust-v*` → `axum-v*` rename; delete it.

## Conventions

- **Independent per-port (and per-Rust-crate) tags**, each scoped to its own
  directory — not a shared `v*`. The ports are hand-written implementations of one
  spec, not generated from a shared core, so they version like an independent
  polyglot monorepo (dependabot already bumps each port on its own schedule).
- **Framework-suffixed package names** — `ashurbanipal-axum`, `-actix-web`,
  `-node-express`, `-flask`, `-spring-boot-starter`. A framework changes the mount
  function's return type, so it's one published artifact per framework, not a
  feature flag. Go is exempt: its `Router` returns the stdlib `http.Handler`.
- **Bare `ashurbanipal` is the Rust core lib only** — a host reaches it
  transitively through an adapter's re-exports, never mounts it directly, so it
  keeps the unsuffixed name.
