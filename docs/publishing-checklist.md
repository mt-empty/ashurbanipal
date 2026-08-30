# Publishing checklist

Status (2026-08-30): all six packaged ports are live on their registries and,
as of the 0.3.0 reset, share one `major.minor` version line — now 0.4.0.

This doc governs *distribution* — whether a port's artifact can leave this repo
and install from a public registry. `PORTING.md` governs *correctness*
(conformance, hardening) before a port is listed in `readme.md`. They're
separate gates.

## What's published

| Port | Package / coordinate | Registry | Latest | Tag prefix | Publish workflow |
|---|---|---|---|---|---|
| Rust core | `ashurbanipal` | crates.io | 0.4.0 | `ashurbanipal-v*` | `rust-core-publish.yml` |
| Rust / Axum | `ashurbanipal-axum` | crates.io | 0.4.0 | `ashurbanipal-axum-v*` | `rust-axum-publish.yml` |
| Rust / Actix-web | `ashurbanipal-actix-web` | crates.io | 0.4.0 | `ashurbanipal-actix-web-v*` | `rust-actix-web-publish.yml` |
| Node / Express | `ashurbanipal-node-express` | npm | 0.4.0 | `ashurbanipal-node-express-v*` | `node-express-publish.yml` |
| Python / Flask | `ashurbanipal-flask` | PyPI | 0.4.0 | `ashurbanipal-flask-v*` | `flask-python-publish.yml` |
| Spring Boot | `io.github.mt-empty:ashurbanipal-spring-boot-starter` | Maven Central | 0.4.0 | `ashurbanipal-spring-boot-starter-v*` | `spring-boot-starter-publish.yml` |
| Go / net-http | `github.com/mt-empty/ashurbanipal/implementations/go-nethttp` | proxy.golang.org | 0.4.0 | `implementations/go-nethttp/v*` | `go-nethttp-publish.yml` |

Latest reflects the 0.3.0 reset once its tags are pushed (Rust was at 0.2.1,
the others at 0.1.1, Go at its initial 0.1.0 — a publish-history artifact, not a
signal).

Tag prefixes are the package name plus `-v` (Go keeps the module-path prefix
`go get` needs). This is so a consumer's Dependabot can match a GitHub Release
to the right port — it filters releases whose tag starts with the package name.
Tags pushed with the retired short prefixes (`axum-v*`, `node-v*`, …) trigger
nothing but a loud failure (`reject-legacy-tags.yml`).

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
2. Update the port's `implementations/<port>/CHANGELOG.md`: run
   `mise run changelog:<port>` (e.g. `changelog:rust-axum`), review the printed
   `## [Unreleased]` section, and paste it under a new `## [X.Y.Z] - <date>`
   heading. `mise run check` fails if the top heading doesn't match the manifest
   version (`changelog:check`).
3. Commit steps 1–2 to `main`, in the same commit that sets the **Latest** column
   of the table above and runs `mise run docs:check-versions --fix`.
4. Tag that commit `<prefix>-vX.Y.Z` (the prefix from the table above), matching
   the manifest version exactly.
5. Push the tag. The publish workflow runs build + test + conformance, asserts
   the tag is on `main` and equals the manifest version, publishes to the
   registry, then its `post-release` job creates the GitHub Release with
   `git-cliff --current` notes (Go's workflow does the same, minus the registry
   step).

## Go — release mechanics

No registry integration; "publishing" is just the tag. It needs the
subdirectory-module path prefix — a short `ashurbanipal-go-v*` tag would never
resolve for `go get`, so Go is the one port that did not move to the
`ashurbanipal-<name>-v*` scheme:

```sh
git tag implementations/go-nethttp/vX.Y.Z && git push --tags
```

`proxy.golang.org` indexes on the first `go get`. The install snippets in
`implementations/go-nethttp/README.md` and `readme.md` use `@latest`, so no
per-bump edit there — the pinned version lives only in the table above.
(`v0.1.0` was the initial tag, before the 0.3.0 reset aligned every port.)
`go-nethttp-publish.yml` re-runs the build + conformance gate on the tagged
commit and creates the GitHub Release; it does not touch any registry.

## Conventions

- **Shared `major.minor`, independent patch.** Every port carries the same `X.Y`
  and bumps it together for any feature or behavioral change — they're one spec at
  one protocol version, and features land across all ports in one PR. The patch
  component is per-port: a port takes a solo `X.Y.Z+1` for an out-of-band fix
  without moving the others. The protocol version (`spec/CHANGELOG.md`, `readme.md`
  table) stays the hard compatibility signal, independent of the package number.
- **Tags stay per-port**, prefixed with the package name (`ashurbanipal-axum-v*`,
  `ashurbanipal-node-express-v*`, …; Go keeps `implementations/go-nethttp/v*`).
  There is no shared `v*` tag. Each registry needs its own publish trigger; the
  package-name prefix also lets a consumer's Dependabot attach the right port's
  GitHub Release. Independent tags, shared version number.
- **Per-port changelog.** Each port has `implementations/<port>/CHANGELOG.md`
  (Keep a Changelog format), generated forward-only from Conventional-Commit
  subjects by `git-cliff` (`cliff.toml`, `mise run changelog:<port>`). The 0.3.0
  section is a hand-written floor — nothing before it is tracked there. The
  wire-contract version stays in `spec/CHANGELOG.md`.
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
