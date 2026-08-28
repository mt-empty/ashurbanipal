# Publishing checklist

Status (2026-08-27): all six packaged ports are live on their registries and,
as of the 0.3.0 reset, share one `major.minor` version line.

This doc governs *distribution* — whether a port's artifact can leave this repo
and install from a public registry. `PORTING.md` governs *correctness*
(conformance, hardening) before a port is listed in `readme.md`. They're
separate gates.

## What's published

| Port | Package / coordinate | Registry | Latest | Tag prefix | Publish workflow |
|---|---|---|---|---|---|
| Rust core | `ashurbanipal` | crates.io | 0.3.0 | `core-v*` | `rust-core-publish.yml` |
| Rust / Axum | `ashurbanipal-axum` | crates.io | 0.3.0 | `axum-v*` | `rust-axum-publish.yml` |
| Rust / Actix-web | `ashurbanipal-actix-web` | crates.io | 0.3.0 | `actix-web-v*` | `rust-actix-web-publish.yml` |
| Node / Express | `ashurbanipal-node-express` | npm | 0.3.0 | `node-v*` | `node-express-publish.yml` |
| Python / Flask | `ashurbanipal-flask` | PyPI | 0.3.0 | `flask-v*` | `flask-python-publish.yml` |
| Spring Boot | `io.github.mt-empty:ashurbanipal-spring-boot-starter` | Maven Central | 0.3.0 | `spring-v*` | `spring-boot-starter-publish.yml` |
| Go / net-http | `github.com/mt-empty/ashurbanipal/implementations/go-nethttp` | proxy.golang.org | 0.3.0 | `implementations/go-nethttp/v*` | none — tag only |

Latest reflects the 0.3.0 reset once its tags are pushed (Rust was at 0.2.1,
the others at 0.1.1, Go at its initial 0.1.0 — a publish-history artifact, not a
signal).

Auth is fully configured for all six:

- **crates.io, npm, PyPI** — OIDC trusted publishing, no stored token. The three
  Rust crates share one `crates-io-publish` GitHub Environment.
- **Maven Central** — `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` +
  `GPG_PRIVATE_KEY` / `GPG_PASSPHRASE` secrets; the `maven-central-publish`
  Environment has a required reviewer before the irreversible deploy.

Every registry publish is effectively irreversible — yank / deprecate only, and
Maven Central is fully immutable. Treat a pushed release tag as final.

## Cutting a release

**Feature release** — anything behavioral or shape-changing (it lands across every
port in one PR): bump the shared `major.minor` for all six ports to the same
`X.Y.0`, one commit, then tag each port. **Patch release** — a port-local fix (a
dependency bump, a language-idiom bugfix, a published-README correction): bump
only that port's patch component and tag only that port; the others don't move.
The next feature release re-aligns everyone at `.0`.

Before tagging anything, in the same release commit: set the **Latest** column
of the "What's published" table above to the target version, run
`mise run docs:check-versions --fix` to propagate it into the hardcoded version
strings in `readme.md`, and commit the result. A human miss then fails CI on the
next PR — `tools/check-doc-versions.sh` (in `mise run check`) diffs the table
against those strings and against the highest matching git tag.

Per port, given the target version:

1. Bump `version` in the port's manifest, on `main`:
   - Rust: `implementations/rust/<crate>/Cargo.toml` (+ `Cargo.lock`) — and each
     adapter's `ashurbanipal = { version = "X.Y" }` bound moves with the core
   - Node: `implementations/node-express/package.json`
   - Flask: `implementations/flask-python/pyproject.toml`
   - Spring: `implementations/spring-boot-starter/build.gradle.kts`
   - Go: no manifest — the tag is the version
2. Commit to `main`.
3. Tag that commit `<prefix>-vX.Y.Z`, matching the manifest version exactly.
4. Push the tag. The publish workflow runs build + test + conformance, asserts
   the tag is on `main` and equals the manifest version, then publishes. (Go has
   no workflow — the pushed tag is the release.)

## Go — release mechanics

No registry integration; "publishing" is just the tag. It needs the
subdirectory-module path prefix — a short `go-v*` tag would never resolve for
`go get`:

```sh
git tag implementations/go-nethttp/vX.Y.Z && git push --tags
```

`proxy.golang.org` indexes on the first `go get`. The install snippets in
`implementations/go-nethttp/README.md` and `readme.md` use `@latest`, so no
per-bump edit there — the pinned version lives only in the table above.
(`v0.1.0` was the initial tag, before the 0.3.0 reset aligned every port.)

## Conventions

- **Shared `major.minor`, independent patch.** Every port carries the same `X.Y`
  and bumps it together for any feature or behavioral change — they're one spec at
  one protocol version, and features land across all ports in one PR. The patch
  component is per-port: a port takes a solo `X.Y.Z+1` for an out-of-band fix
  without moving the others. The protocol version (`spec/CHANGELOG.md`, `readme.md`
  table) stays the hard compatibility signal, independent of the package number.
- **Tags stay per-port**, each scoped to its own directory — there is no shared
  `v*` tag. Each registry needs its own publish trigger, and Go's tag needs its
  module-path prefix. Independent tags, shared version number.
- **The frontend is not released standalone.** `dbviewer.html` ships only embedded
  in a port. Each port pins the canonical `frontend/dbviewer.html` at a commit and
  re-hashes its vendored copy in its own CI (`PORTING.md` vendoring section); there
  is no separate GitHub Release or `frontend-v*` tag.
- **Framework-suffixed package names** — `ashurbanipal-axum`, `-actix-web`,
  `-node-express`, `-flask`, `-spring-boot-starter`. A framework changes the mount
  function's return type, so it's one published artifact per framework, not a
  feature flag. Go is exempt: its `Router` returns the stdlib `http.Handler`.
- **Bare `ashurbanipal` is the Rust core lib only** — a host reaches it
  transitively through an adapter's re-exports, never mounts it directly, so it
  keeps the unsuffixed name.
