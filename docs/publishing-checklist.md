# Publishing checklist

Status: `ashurbanipal` (core) and `ashurbanipal-actix-web` are published
at 0.1.0, following the core-extraction (#38), Actix-web port (#39), and
flat-sibling-layout restructure (#41) all merging to `main`.
`ashurbanipal-axum` can't reuse 0.1.0 for its post-extraction content (see
its per-port gap below), so all three crates are bumped to 0.2.0 together
for the next release — a coordinated minor release, not three independent
patch bumps, since axum's version had to move regardless and the other
two rode along rather than drifting out of step for no reason. The other
four ports (Node, Flask, Spring, Go)
remain unpublished; each README says so explicitly
(`implementations/go-nethttp/README.md:9`, and the equivalent "not yet"
framing implied by node-express's `"private": true` and flask-python's
missing PyPI metadata — see per-port gaps below). This document is the
plan for closing that gap for the remaining four.

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
| Spring Boot starter (`implementations/spring-boot-starter`) | Maven Central (Sonatype Central Portal) | `./gradlew publish` | Central Portal namespace verification for `io.github.mt-empty` + GPG artifact signing | No — Central is immutable |
| Go (`implementations/go-nethttp`) | `pkg.go.dev` / `proxy.golang.org` | `git tag implementations/go-nethttp/vX.Y.Z && git push --tags` | none — the public repo is the source of truth, proxy indexes on first fetch | Tag can be deleted, but the module proxy's cache is effectively permanent |

Go needs no registry integration at all — "publishing" is already fully
described by the existing tag-triggered `.github/workflows/release.yml`.
Maven Central has the highest setup cost (identity verification + signing
key management, both one-time but slow — namespace verification alone
can take days). crates.io/npm/PyPI's OIDC trusted-publishing removes the
"store a long-lived registry token in GitHub secrets" step entirely and
is the recommended auth model for all three; use it instead of a classic
token unless a specific reason rules it out.

## Decided: per-port tag scheme

Per-port tag prefixes (`axum-vX.Y.Z`, `node-vX.Y.Z`, `flask-vX.Y.Z`,
`spring-vX.Y.Z`), each triggering its own publish job scoped
to that one port's directory — not the bare `v*` scheme. **Go is the one
exception**: its module (`implementations/go-nethttp/go.mod`) doesn't live
at the repo root, and Go's module tooling requires a subdirectory
module's version tag to be prefixed with the module's own path within the
repo (`golang.org/ref/mod#vcs-version`) — so its tag is
`implementations/go-nethttp/vX.Y.Z`, not a short `go-vX.Y.Z` prefix. A
`go-v0.1.0` tag would simply never resolve for `go get
github.com/mt-empty/ashurbanipal/implementations/go-nethttp@v0.1.0`.
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

**Amendment (added once Rust became three crates instead of one):** the
scheme goes one level finer inside Rust itself, per-crate rather than
per-port (originally `rust-vX.Y.Z` for the single Rust port, renamed to
`axum-vX.Y.Z` once axum was one of three crates rather than "Rust" as a
whole, for parity with the other two prefixes below) —
`axum-vX.Y.Z` (`ashurbanipal-axum`, `rust-axum-publish.yml`),
`core-vX.Y.Z` (`ashurbanipal`, `rust-core-publish.yml`), and
`actix-web-vX.Y.Z` (`ashurbanipal-actix-web`,
`rust-actix-web-publish.yml`) each tag and release independently. All
three share their tag/version-verification and build+dry-run-package
logic via a reusable `_rust-crate-publish-check.yml` workflow (the same
`workflow_call`-with-`with:`-inputs pattern this doc's conformance suite
already uses for `_conformance-behavior.yml`/`_conformance-schema.yml`) —
each crate's own workflow file only adds what's genuinely per-crate: the
axum/actix-web conformance jobs (core has no HTTP surface to conform) and
the final `publish` job (all three share the same `crates-io-publish`
GitHub Environment — see the amendment on that below). Same
rationale as the per-port split: the three crates already version
independently in `Cargo.toml` (`ashurbanipal-axum` is on 0.1.0 published
pre-core-extraction and can't reuse that number for its post-extraction
content; `ashurbanipal` and `ashurbanipal-actix-web` started fresh at
0.1.0 on 2026-08-14), so one shared Rust-wide tag would force artificial
version lockstep across crates that don't actually need to move together.

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
source) -> Router` signature (`implementations/rust/axum/src/routes.rs:32`),
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
— `ashurbanipal-axum` and `ashurbanipal-actix-web` both depend on plain
`ashurbanipal` (path dep today, `implementations/rust/core`) rather than
on each other.

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
   Maven `io.github.mt-empty`/`ashurbanipal-spring-boot-starter`
   coordinate, and the Go module path (`go get` needs no reservation,
   it's the repo path) should each be checked for squatting/collisions on
   their respective registry before the first publish, not after a failed
   `publish` command reveals it. — *Done for Rust*: all three crate names
   (`ashurbanipal-axum`, `ashurbanipal`, `ashurbanipal-actix-web`)
   confirmed via the crates.io API before their respective bootstrap
   publishes; `ashurbanipal` and `ashurbanipal-actix-web` are now live,
   `ashurbanipal-axum` still needs its version-bump republish (see
   per-port gaps below). Node, Flask, Spring still pending.
6. **CI publish job gated on the port's own tag prefix**, using
   OIDC trusted publishing where the registry supports it, mirroring
   `release.yml`'s existing `check-branch` job (tag must be on `main`)
   rather than trusting whoever cut the tag. — *Done for Rust*:
   `rust-axum-publish.yml`, `rust-core-publish.yml`, and
   `rust-actix-web-publish.yml` (the latter two added once Rust became
   three independently-tagged crates, see the tag-scheme amendment above)
   all do this exact check via their shared `_rust-crate-publish-check.yml`
   job, and the `refactor/frontend-typescript-modules` branch carrying all
   the rename/vendoring work merged into `main` (PR #37, `614cdf0`), so a
   `axum-v*` tag cut from current `main` will pass the gate.
   All three `publish` jobs declare `environment: crates-io-publish` — one
   shared environment across all three crates rather than one per crate,
   since there's a single reviewer (`mt-empty`) for the whole project and
   a GitHub Environment's deployment branch/tag policy accepts multiple
   patterns, so `axum-v*`/`core-v*`/`actix-web-v*` can all be registered
   under it without losing per-tag scoping. — *configured*: required
   reviewer `mt-empty`, deployment restricted to tags matching those three
   patterns (a tag policy, not a branch policy — these workflows trigger
   on a tag push, so a `main`-only branch policy would never match the tag
   ref and would silently block every run). `core-v*`/`actix-web-v*` were
   added directly in GitHub Settings; the environment's original pattern
   was `rust-v*` (from when `rust-axum-publish.yml` used that tag prefix)
   and needs renaming to `axum-v*` to match the workflow's current trigger
   — do this before cutting the first `axum-v*` tag, or the `publish` job
   will run with no gate at all. On crates.io's side, all three crates'
   Trusted Publisher config uses the same environment name
   (`crates-io-publish`), just a different workflow filename each.
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
     (`implementations/rust/axum/frontend/`,
     `implementations/rust/actix-web/frontend/`,
     `implementations/go-nethttp/frontend/`)
     — `cargo publish`/`go get module@tag` both need the file present in
     an actual git commit at package time (verified empirically for Cargo:
     even a staged-but-uncommitted file forces `--allow-dirty`, which
     would also silently permit any *other* accidentally-uncommitted
     change into an irreversible release — not a tradeoff worth taking).
     `tools/sync-ports-frontend.sh --check` diffs all three against the
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

- **Rust — `ashurbanipal` core** (`implementations/rust/core/Cargo.toml`)
  — **published**: `ashurbanipal` 0.1.0 went live on crates.io on
  2026-08-14 (one-time manual bootstrap publish with a classic API token,
  per gate item 6's caveat — Trusted Publishing can't be configured until
  a crate exists). `rust-core-publish.yml` now exists for future releases
  (`core-vX.Y.Z` tags) — GitHub Environment still open, see gate item 6.
- **Rust — `ashurbanipal-actix-web`**
  (`implementations/rust/actix-web/Cargo.toml`) — **published**:
  `ashurbanipal-actix-web` 0.1.0 went live on crates.io on 2026-08-14
  (same one-time manual bootstrap as core, now that its `ashurbanipal`
  path+version dependency resolves for real). `rust-actix-web-publish.yml`
  now exists for future releases (`actix-web-vX.Y.Z` tags) — same
  GitHub-Environment gap as core, see gate item 6. README's install
  section updated from "not yet published" to the real `cargo add`
  instructions.
- **Rust — `ashurbanipal-axum`** (`implementations/rust/axum/Cargo.toml`)
  — ~~missing `repository`, `readme`~~ **closed**: both fields added,
  `cargo metadata` confirms they resolve correctly. Package renamed
  `ashurbanipal` → `ashurbanipal-axum` (lib target `ashurbanipal_axum`) —
  deliberately suffixed rather than bare, per the naming decision below;
  every `use ashurbanipal::...` / `ashurbanipal::router(...)` reference in
  `README.md`, `examples/demo.rs`, `src/lib.rs`'s doctest,
  `tests/schema_isolation*.rs`, `conformance/runner/common.rs`,
  `CLAUDE.md`, and `docs/design.md` was updated to match; `cargo
  build`/`cargo test --doc`/`cargo clippy --all-features -- -D warnings`
  all pass under the new name. Frontend vendoring blocker (gate item 7) is
  also now closed — `cargo publish --dry-run` packages, verifies, and gets
  to the upload step cleanly. No remaining manifest gaps. Name
  availability confirmed (`ashurbanipal-axum` unclaimed on crates.io at
  the time) and the branch carrying all this work merged to `main` (PR
  #37) — `rust-axum-publish.yml`'s branch-check gate will now pass.
  **Blocker closed**: `ashurbanipal-axum` 0.1.0 was already published to
  crates.io on 2026-08-11, *before* the core-extraction (PR #38,
  2026-08-12) — that published version has no dependency on `ashurbanipal`
  at all (confirmed via crates.io's dependency API; it's the
  pre-extraction, single-crate content). crates.io permanently reserves
  version numbers, so the current in-repo `ashurbanipal-axum` (which now
  depends on the published `ashurbanipal` core crate) can't be republished
  as 0.1.0 — bumped to 0.2.0 (`implementations/rust/axum/Cargo.toml`),
  alongside `ashurbanipal` and `ashurbanipal-actix-web` (also bumped to
  0.2.0, coordinated for this release — see the status line at the top).
  The `ashurbanipal` path+version dependency requirement was bumped to
  `"0.2"` to match. Also renamed the tag prefix `rust-axum-publish.yml`
  triggers on from `rust-v*` to `axum-v*`, for parity with `core-v*`/
  `actix-web-v*` (see gate item 6's note on the environment's tag policy
  needing the same rename).
- **Node** (`implementations/node-express/package.json`) — ~~`"private":
  true` blocks `npm publish`; missing `repository`, `license`,
  `homepage`~~ **closed**: `private` removed, all three fields added.
  `author` deliberately left out — no attributable individual/org name is
  documented elsewhere in the repo to source it from. **Also found and
  fixed while wiring the publish workflow**: no `"main"`/`"types"` field
  and `"files"` never included the compiled `dist/` output — `tsconfig.json`
  had `"declaration": false` — so `npm install ashurbanipal-node-express`
  would have shipped a package with no resolvable entry point at all.
  Fixed: `"main": "dist/src/index.js"`, `"types": "dist/src/index.d.ts"`
  (tsconfig's `rootDir: "."` mirrors `src/` under `dist/src/`, not flat
  into `dist/` — verified by an actual `npm run build` + `node -e
  "import('./dist/src/index.js')"`, not just reading the config), `"dist"`
  added to `files`, `"declaration": true` enabled. Also fixed the same
  wrong `dist/db/...` deep-import path (should be `dist/src/db/...`) in
  `src/index.ts`'s comment and `README.md`'s MySQL/SQLite rows and
  "Backend selection" example — a pre-existing doc bug, same root cause.
  `node-express-publish.yml` now exists (`node-vX.Y.Z` tags, npm OIDC
  Trusted Publishing via `id-token: write` + `npm publish --provenance`),
  sharing its build/test gate with `node-conformance.yml` through the new
  `_node-build-test.yml`. **Still open**: npm's Trusted Publisher config
  needs a package that already exists on the registry (like crates.io),
  so the first `npm publish` needs a one-time manual bootstrap with a
  classic token before Trusted Publishing can be attached — not done yet.
- **Flask** (`implementations/flask-python/pyproject.toml`) — ~~missing
  `license`, `readme`, `authors`, `classifiers`, `[project.urls]`~~
  **closed**: all added (`authors` sourced from the root `LICENSE`'s
  copyright holder, the only place that name is already on record).
  `flask-python-publish.yml` now exists (`flask-vX.Y.Z` tags, PyPI OIDC
  Trusted Publishing via `pypa/gh-action-pypi-publish`), sharing its
  build/test gate with `flask-conformance.yml` through the new
  `_flask-build-test.yml`. Unlike npm/crates.io, PyPI supports a *pending*
  Trusted Publisher registered before the project exists — no bootstrap
  token needed, just registering the pending publisher on pypi.org before
  the first `flask-v*` tag. **Still open**: that pending-publisher
  registration itself hasn't been done yet. (`uv build --sdist` already
  confirmed the metadata parses and builds.)
- **Spring Boot starter**
  (`implementations/spring-boot-starter/build.gradle.kts`) — ~~missing
  POM `licenses`/`developers`/`scm`~~ **closed**: `pom { }` block added to
  the `maven` publication; `generatePomFileForMavenPublication` confirms
  the generated POM carries all of them. Version is still
  `0.1.0-SNAPSHOT` — left alone deliberately, see gate item 1. The
  `publishing.repositories` block is still the inert placeholder (no
  credentials, never run by CI) — untouched, since wiring real Central
  Portal credentials needs a publish workflow + GPG signing setup first.
  **Namespace verification for `io.github.mt-empty` is done** — already
  verified on Sonatype Central Portal (note: the group ID was previously
  the wrong, unhyphenated `io.github.mtempty`, which would have silently
  failed verification since Central checks the namespace against the
  exact GitHub username; fixed to `io.github.mt-empty` in
  `build.gradle.kts`, matching the verified namespace — the Kotlin
  package names under `io.github.mtempty.ashurbanipal` are unaffected,
  since Java/Kotlin package identifiers can't contain a hyphen and don't
  need to match the Maven groupId). **Still open**: GPG signing-key setup
  and wiring real Central Portal publish credentials + a `spring-v*`-gated
  publish workflow — not done yet.
- **Go** (`implementations/go-nethttp`) — nothing blocking. The module is
  already well-formed and `implementations/go-nethttp/README.md:9-15`
  already documents the intended `go get ...@vX.Y.Z` usage. The only
  action is cutting a real tag — and it must be
  `implementations/go-nethttp/vX.Y.Z`, per the subdirectory-module tag
  rule noted above, not a short `go-vX.Y.Z` prefix.

## Suggested rollout order

1. ~~Go first~~ — still pending, effectively free (no registry, no
   credentials); doubles as a live test of the tag-triggered release
   workflow and the per-port tag scheme above.
2. ~~Rust next~~ **done**: all three crates (`ashurbanipal-axum`,
   `ashurbanipal`, `ashurbanipal-actix-web`) have cleared their manifest
   gaps and two are live on crates.io; validated the "port has its own
   publish job" pattern (now three jobs, one per crate — see the
   per-crate tag-scheme amendment above). Remaining Rust work is the
   `ashurbanipal-axum` version bump and the two new crates' GitHub
   environments, both tracked in the per-port gaps above — not new
   pattern validation.
3. **Node and Flask** — `node-express-publish.yml` and
   `flask-python-publish.yml` now both exist, mirroring the Rust jobs'
   pattern end-to-end (shared build/test gate, conformance, OIDC Trusted
   Publishing). **Still open before either can actually run**: npm's
   one-time manual-token bootstrap publish (Trusted Publisher config
   needs the package to exist first) and registering PyPI's pending
   Trusted Publisher for `ashurbanipal-flask` — both are external,
   registry-side steps, not something a workflow file can do.
4. **Spring Boot starter last** — namespace verification for
   `io.github.mt-empty` is already done; GPG signing-key setup and a
   `spring-v*` publish workflow are the remaining slow, least-automatable
   parts. Start GPG key generation whenever there's a target date, but
   don't let it block the other three remaining ports' publish jobs from
   landing.
