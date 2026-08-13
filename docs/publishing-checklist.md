# Publishing checklist

Status: none of the five ports are published to a registry today; each
README says so explicitly (`implementations/rust/README.md:5`,
`implementations/go-nethttp/README.md:9`, and the equivalent "not yet"
framing implied by node-express's `"private": true` and flask-python's
missing PyPI metadata — see per-port gaps below). This document is the
plan for closing that gap.

This is a different concern from `PORTING.md`: the porting bar gates a
port's *correctness* (protocol conformance, hardening, tests) before it's
listed in `readme.md`. This document gates a port's *distribution* —
whether its artifact can leave this repo and be installed from a public
registry. A port can clear the porting bar and still not be publish-ready
(all five currently are in exactly this state).

## Registries and trigger model

| Port | Registry | Publish trigger | Auth model | Reversible? |
|---|---|---|---|---|
| Rust (`implementations/rust`) | crates.io | `cargo publish` | API token, or crates.io's OIDC trusted-publishing (GitHub Actions) | No — yank only, never deleted |
| Node (`implementations/node-express`) | npm | `npm publish` | npm token, or npm's GitHub Actions OIDC trusted publishing | No — unpublish is time/dependent-limited |
| Flask (`implementations/flask-python`) | PyPI | `uv publish` / `twine upload` | PyPI Trusted Publishing (OIDC, no stored token) | No — yank only |
| Spring Boot starter (`implementations/spring-boot-starter`) | Maven Central (Sonatype Central Portal) | `./gradlew publish` | Central Portal namespace verification for `io.github.mtempty` + GPG artifact signing | No — Central is immutable |
| Go (`implementations/go-nethttp`) | `pkg.go.dev` / `proxy.golang.org` | `git tag vX.Y.Z && git push --tags` | none — the public repo is the source of truth, proxy indexes on first fetch | Tag can be deleted, but the module proxy's cache is effectively permanent |

Go needs no registry integration at all — "publishing" is already fully
described by the existing tag-triggered `.github/workflows/release.yml`.
Maven Central has the highest setup cost (identity verification + signing
key management, both one-time but slow — namespace verification alone
can take days). crates.io/npm/PyPI's OIDC trusted-publishing removes the
"store a long-lived registry token in GitHub secrets" step entirely and
is the recommended auth model for all three; use it instead of a classic
token unless a specific reason rules it out.

## Decided: per-port tag scheme

Per-port tag prefixes (`rust-vX.Y.Z`, `node-vX.Y.Z`, `flask-vX.Y.Z`,
`spring-vX.Y.Z`, `go-vX.Y.Z`), each triggering its own publish job scoped
to that one port's directory — not the bare `v*` scheme
`.github/workflows/release.yml` uses today. Rationale: the five ports are
independently hand-written implementations of the same spec, not outputs
of one shared generator (contrast Protocol Buffers, which locksteps every
language to one release number specifically because they *are* generated
from one core) — closer to the Changesets/Lerna-`--independent`
polyglot-monorepo pattern, where each package tags and versions on its
own. This already matches how the repo behaves: dependabot bumps each
port's dependencies on its own schedule with zero coordination (e.g.
`00d603b` touched only `spring-boot-starter/build.gradle.kts`, `f632b20`
touched only `flask-python/pyproject.toml`). A shared tag would also let
Maven Central's namespace-verification/signing lag gate every other
port's release, which defeats the point of publishing them separately.

The frontend-artifact release that `release.yml` does today (vendored
`dbviewer.html` + `LICENSE`) is really a sixth, separate "thing that gets
released" — keep it on its own tag prefix (e.g. `frontend-vX.Y.Z`) rather
than the bare `v*` once any port's tag scheme is wired up, so a port tag
and a frontend tag can never collide.

## Decided: no bare `ashurbanipal` package name

Every port's published name is suffixed with its framework/ecosystem
identifier — Rust is `ashurbanipal-axum` (renamed from bare `ashurbanipal`),
matching Node's `ashurbanipal-node-express`, Flask's `ashurbanipal-flask`,
and Spring's `ashurbanipal-spring-boot-starter`, which were already
suffixed. Rationale: a web framework isn't an injectable dependency the
way a DB backend is — `DbSource` swaps behind a fixed `router(config,
source) -> Router` signature (`implementations/rust/src/routes.rs:32`),
but a different framework changes the function's *return type itself*
(`axum::Router` vs. `actix_web::Scope`, `Blueprint` vs. an ASGI app), so
one framework per published artifact is the natural boundary, not an
internal feature flag. Real precedent for the `<core>-<framework>` suffix
shape: `juniper_axum`/`juniper_actix`/`juniper_warp`/`juniper_rocket`,
`async-graphql-axum`/`async-graphql-actix-web`/`async-graphql-warp`,
`utoipa-axum`/`utoipa-actix-web`, `askama_axum` — all libraries that mount
into a host framework the same way ashurbanipal does, all shipping one
crate per framework rather than one bare crate spanning frameworks.
Go is the one port exempt from ever needing this: `Router(cfg, source)
(http.Handler, error)` (`implementations/go-nethttp/routes.go:44`) already
returns the stdlib interface every Go framework speaks, so it needs no
per-framework split, ever.

**Amendment (added when `ashurbanipal-axum`'s framework-agnostic modules
were extracted into their own crate):** this "no bare name" rule is about
HTTP-facing, host-embedded artifacts specifically — the thing whose public
API includes a framework-specific return type. It does not apply to an
internal core library that a host never imports by name directly (it's
only reached transitively through a framework adapter's re-exports). The
bare name `ashurbanipal` is reserved for exactly that role, per
`docs/feature-backlog/15-core-lib-plus-per-framework-adapter-per-port.md`
— `ashurbanipal-axum` depends on plain `ashurbanipal` (path dep today,
`implementations/rust/core`), and any future `ashurbanipal-actix-web` will
do the same.

## Common gate items (every port, before its first publish)

1. **Version discipline.** No `-SNAPSHOT`/`0.0.0` placeholder at publish
   time; the tag and the manifest version must agree (CI should assert
   this, not trust it by convention). — *Pending*: all four still carry
   their pre-release version (correct until an actual publish is imminent).
2. **License metadata matches the root `LICENSE`** (MIT) in the
   ecosystem's own manifest field, not just implied by the repo. — *Done*
   for Rust, Node, Flask, and the Spring starter's generated POM.
3. **`repository`/`homepage` URL** pointing at this repo's
   `implementations/<port>` subdirectory, so registry pages link back
   correctly in a monorepo (a bare repo URL without a `directory` field is
   misleading — npm, Cargo, and PyPI's project-urls all support scoping
   this to a subdirectory). — *Done* for Rust, Node, Flask, and the Spring
   starter's generated POM (`scm`/`url` fields).
4. **README documents the real install command** for that registry (`cargo
   add`, `npm install`, `pip install`/`uv add`, the Gradle/Maven
   coordinate, `go get ...@vX.Y.Z`) — replacing the current
   path/git-dependency instructions.
5. **Registry name availability confirmed before committing to it** —
   `ashurbanipal-axum`, `ashurbanipal-flask`, `ashurbanipal-node-express`, the
   Maven `io.github.mtempty`/`ashurbanipal-spring-boot-starter`
   coordinate, and the Go module path (`go get` needs no reservation,
   it's the repo path) should each be checked for squatting/collisions on
   their respective registry before the first publish, not after a failed
   `publish` command reveals it. — *Done for Rust*: `curl`'d
   `https://crates.io/api/v1/crates/ashurbanipal-axum` directly, got
   `"crate \`ashurbanipal-axum\` does not exist"` — unclaimed. Node, Flask,
   Spring still pending.
6. **CI publish job gated on the port's own tag prefix**, using
   OIDC trusted publishing where the registry supports it, mirroring
   `release.yml`'s existing `check-branch` job (tag must be on `main`)
   rather than trusting whoever cut the tag. — *Done for Rust*:
   `rust-publish.yml`'s `check-branch` job does this exact check, and the
   `refactor/frontend-typescript-modules` branch carrying all the rename/
   vendoring work merged into `main` (PR #37, `614cdf0`), so a `rust-v*`
   tag cut from current `main` will pass the gate. `rust-publish.yml`'s
   `publish` job also declares `environment: crates-io-publish` — *now
   configured*: required reviewer `mt-empty`, and deployment restricted to
   tags matching `rust-v*` (a tag policy, not a branch policy — this
   workflow triggers on a tag push, so a `main`-only branch policy would
   never match the tag ref and would silently block every run).
7. **Decide whether `frontend/dbviewer.html` needs to be independently
   versioned/pinned** for a published artifact the way `PORTING.md`'s
   vendoring contract already expects in spirit (each port re-hashes it
   at build/CI time against a pinned sha256) — today every port pins
   against this repo's own working-tree copy because "no tagged
   `frontend/dbviewer.html` release currently exists to vendor from" per
   `PORTING.md`'s vendoring section. A real publish is the point where
   that stops being true and each port's pinned hash should point at an
   actual tagged frontend release instead. This item is still open for
   all five — nothing below closes it, it's about *what* gets pinned, not
   *how* the vendored copy reaches each port.
   — *Vendoring mechanism itself is now closed for every port*, and turned
   out to differ by ecosystem rather than being uniform (see `PORTING.md`'s
   vendoring section for the full per-port rationale):
   - **Rust and Go commit a real vendored copy**
     (`implementations/rust/frontend/`, `implementations/go-nethttp/frontend/`)
     — `cargo publish`/`go get module@tag` both need the file present in
     an actual git commit at package time (verified empirically for Cargo:
     even a staged-but-uncommitted file forces `--allow-dirty`, which
     would also silently permit any *other* accidentally-uncommitted
     change into an irreversible release — not a tradeoff worth taking).
     `tools/sync-ports-frontend.sh --check` diffs both against the
     canonical file in CI.
   - **Spring, Node, and Flask generate theirs ephemerally instead** —
     gitignored, never committed, regenerated on demand, since neither
     Gradle, npm, nor hatchling has Cargo's uncommitted-file restriction.
     Spring's `vendorFrontend` Gradle task already did this. Node now
     mirrors it via a `sync-frontend` npm script wired into `pretest`/
     `prebuild`/`predemo`/`prepack` hooks (verified: `pnpm test`, `npm
     pack --dry-run` both regenerate it automatically, byte-identical to
     the canonical file, and `npm pack`'s file list is unchanged from
     before via an explicit `files` field, since gitignoring it would
     otherwise silently drop it from the tarball). Flask now mirrors it
     via an explicit `tools/sync-ports-frontend.sh` step added to
     `flask-conformance.yml` (Python has no pre-hook convention to hang it
     off automatically) plus a `[tool.hatch.build.targets.wheel]
     artifacts` entry in `pyproject.toml` to force past hatchling's own
     gitignore-based default exclusion.
   - **Found and fixed a real, pre-existing bug while doing this**: Flask's
     vendored copy lived at `implementations/flask-python/frontend/`,
     *outside* the `ashurbanipal` package `pyproject.toml` actually
     packages (`packages = ["ashurbanipal"]`). Built and inspected the
     actual wheel (`uv build --wheel` + `zipfile -l`) — it shipped with no
     `frontend/dbviewer.html` at all, meaning `pip install ashurbanipal-flask`
     would have crashed at import time (`embed.py`'s module-level
     `_load_frontend()` call). Fixed by moving the vendored copy to
     `implementations/flask-python/ashurbanipal/frontend/dbviewer.html`
     (inside the packaged directory) and updating `embed.py`'s path to
     match; confirmed fixed by rebuilding the wheel and inspecting its
     contents again.

## Per-port gaps (found by reading current manifests)

- **Rust** (`implementations/rust/Cargo.toml`) — ~~missing `repository`,
  `readme`~~ **closed**: both fields added, `cargo metadata` confirms they
  resolve correctly. Package renamed `ashurbanipal` → `ashurbanipal-axum`
  (lib target `ashurbanipal_axum`) — deliberately suffixed rather than
  bare, per the naming decision below; every `use ashurbanipal::...` /
  `ashurbanipal::router(...)` reference in `README.md`, `examples/demo.rs`,
  `src/lib.rs`'s doctest, `tests/schema_isolation*.rs`,
  `conformance/runner/common.rs`, `CLAUDE.md`, and `docs/design.md` was
  updated to match; `cargo build`/`cargo test --doc`/`cargo clippy
  --all-features -- -D warnings` all pass under the new name. Frontend
  vendoring blocker (gate item 7) is also now closed — `cargo publish
  --dry-run` packages, verifies, and gets to the upload step cleanly. No
  remaining manifest gaps. Name availability confirmed (`ashurbanipal-axum`
  unclaimed on crates.io) and the branch carrying all this work merged to
  `main` (PR #37) — `rust-publish.yml`'s `check-branch` gate will now pass.
  `crates-io-publish` environment's required-reviewer + tag-restriction
  protection rules are configured. Only remaining: the one-time manual
  bootstrap publish (classic API token, can't be automated — see the
  workflow's header comment) and cutting the `rust-v0.1.0` tag itself.
  **New blocker, introduced by the `ashurbanipal` core-crate extraction**
  (PR #38) and confirmed by direct reproduction: `ashurbanipal-axum` now
  depends on the never-published `ashurbanipal` core crate via a
  path+version dependency (`implementations/rust/Cargo.toml`), so
  `cargo publish -p ashurbanipal-axum --dry-run` fails with `no matching
  package named 'ashurbanipal' found, location searched: crates.io
  index`. `rust-publish.yml`'s `build-and-test` (dry-run) and `publish`
  (real) jobs will both fail on the next `rust-v*` tag push until
  `ashurbanipal` is published to crates.io first (own bootstrap publish +
  Trusted Publishing config, same process the axum crate itself went
  through) — this must happen before, or as part of, the next Rust
  release, not after.
- **Node** (`implementations/node-express/package.json`) — ~~`"private":
  true` blocks `npm publish`; missing `repository`, `license`,
  `homepage`~~ **closed**: `private` removed, all three fields added.
  `author` deliberately left out — no attributable individual/org name is
  documented elsewhere in the repo to source it from.
- **Flask** (`implementations/flask-python/pyproject.toml`) — ~~missing
  `license`, `readme`, `authors`, `classifiers`, `[project.urls]`~~
  **closed**: all added (`authors` sourced from the root `LICENSE`'s
  copyright holder, the only place that name is already on record). `uv
  build --sdist` confirms the metadata parses and builds.
- **Spring Boot starter**
  (`implementations/spring-boot-starter/build.gradle.kts`) — ~~missing
  POM `licenses`/`developers`/`scm`~~ **closed**: `pom { }` block added to
  the `maven` publication; `generatePomFileForMavenPublication` confirms
  the generated POM carries all of them. Version is still
  `0.1.0-SNAPSHOT` — left alone deliberately, see gate item 1. The
  `publishing.repositories` block is still the inert placeholder (no
  credentials, never run by CI) — untouched, since wiring real Central
  Portal credentials needs the namespace-verification step (below) to
  exist first. **Still open and gating everything else for this port**:
  namespace verification for `io.github.mtempty` (one-time, manual,
  can take days — start it first if Maven Central is in scope) and a GPG
  signing-key setup.
- **Go** (`implementations/go-nethttp`) — nothing blocking. The module is
  already well-formed and `implementations/go-nethttp/README.md:9-15`
  already documents the intended `go get ...@vX.Y.Z` usage. The only
  action is cutting a real tag.

## Suggested rollout order

1. **Go first** — effectively free (no registry, no credentials); doubles
   as a live test of the tag-triggered release workflow and the per-port
   tag scheme above before anything with real registry credentials is at
   stake.
2. **Rust next** — single static-or-OIDC token, smallest manifest gap,
   and it's the reference implementation other ports are diffed against
   (`docs/adapter-decisions.md`), so it's the natural one to validate the
   whole "port has its own publish job" pattern against.
3. **Node and Flask** — similar complexity to each other (OIDC trusted
   publishing supported by both registries), can proceed in either order
   or in parallel once the Rust job's pattern is proven out.
4. **Spring Boot starter last** — namespace verification and GPG signing
   are the slowest, least automatable parts of this whole effort; start
   the manual verification step early if there's a target date, but don't
   let it block the other four ports' publish jobs from landing.
