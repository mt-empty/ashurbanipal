# Porting Ashurbanipal

Status: the full checklist — what a port is, what it reuses, what it
implements, what it must not do, how to run conformance, the listing bar,
and governance — is written below, informed by two actual ports (Spring
Boot, Go). Sidecar guidance (a non-port alternative for unsupported
stacks, e.g. pgweb) is deliberately out of scope for this document —
see `readme.md`'s sidecar section instead.

## What a port is

An implementation of `spec/protocol.md` at a specific protocol version,
that:

1. Serves the released `frontend/dbviewer.html` artifact, vendored (see
   below), unmodified.
2. Implements the seven API routes + the HTML route exactly as
   `spec/protocol.md` and `spec/openapi.yaml` specify them.
3. Passes both conformance layers (behavior + shape) in its own CI.

No implementation — the Rust one included — is structurally privileged;
a port is a peer, not a lesser copy.

## What you reuse

- **The frontend artifact** — `frontend/dbviewer.html`, pinned by release
  tag + sha256 + `NOTICE` (see "Vendoring the frontend" below). This also
  means reusing the one and only filter-grammar parser implementation;
  no port writes its own.
- **The filter fixtures** — `spec/fixtures/filter-builder-tests.json` (the
  AST → WHERE-fragment cases every backend, reference and ports alike, is
  tested against). `spec/fixtures/parser-tests.json` is frontend-only —
  no port consumes it, since no port parses DSL text.
- **The conformance seed + runner** — `conformance/seed/seed.sql` (apply
  once against your target database) and `conformance/runner` (drives
  HTTP assertions at your running instance). See "How to run conformance"
  below for exact invocation.

## Vendoring the frontend

`frontend/dbviewer.html` is released as a versioned artifact attached to
each tagged GitHub Release, alongside `LICENSE` and a `dbviewer.html.sha256`
checksum. An implementation that serves the UI vendors this file rather
than writing its own:

1. Pin a specific release tag — don't track a branch or `main`.
2. Record the `dbviewer.html.sha256` value for the tag you vendor.
3. Ship `NOTICE` alongside your vendored copy (provenance + the MIT license
   text) if the file is vendored outside a clone of this repository and so
   wouldn't otherwise carry `LICENSE` with it.
4. Re-verify the hash in your own CI on every build — per the hardening
   checklist below (item 3), a build pipeline (bundler, resource
   filtering) can silently mangle the vendored file without anyone
   touching this repository's code. Don't just record the hash once at
   vendoring time and trust it forever after.

Since the frontend is the single canonical implementation of the filter
grammar parser (`spec/filter-dsl.md`), vendoring it pins filter *syntax*
compatibility, not just UI/UX — treat a version bump here with the same
care as a `spec/protocol.md` version bump.

Within this repository, `mise run frontend:sync-ports` regenerates every
port's own copy from the canonical `frontend/dbviewer.html`, but *where*
that copy lives differs by ecosystem, driven by what each one's packaging
tooling actually requires:

- **Rust and Go commit theirs** (`implementations/rust/axum/frontend/`,
  `implementations/rust/actix-web/frontend/`,
  `implementations/go-nethttp/frontend/`) — `cargo publish` refuses to
  package any file that isn't committed to git (verified: even a `git
  add`-staged-but-uncommitted file triggers the "uncommitted changes"
  error and forces `--allow-dirty`, which would also silently permit any
  *other* accidentally-uncommitted change into an irreversible, yank-only
  release), and Go modules have no separate "package" step at all — `go
  get module@tag` fetches exactly what's in that tagged commit. `mise run
  frontend:check-ports-sync` diffs all three against the canonical file in
  CI; Go additionally keeps a `pinnedFrontendSHA256` checksum constant in
  `embed.go`, re-verified at every process start.
- **Spring, Node, and Flask generate theirs ephemerally** — gitignored,
  never committed, regenerated whenever needed. None of these three
  ecosystems has Cargo's "refuse on uncommitted files" behavior, so there's
  no safety net to lose by doing this: Spring's `vendorFrontend` Gradle
  task copies it into a `build/` output directory at every build; Node's
  `package.json` wires a `sync-frontend` script into `pretest`/`prebuild`/
  `predemo`/`prepack` hooks so any of `pnpm test`/`build`/`demo`/`npm pack`
  regenerates it automatically; Flask has no such hook convention
  available, so `flask-conformance.yml` calls
  `tools/sync-ports-frontend.sh` as an explicit CI step, and its
  `pyproject.toml` force-includes the gitignored file into the wheel via
  `[tool.hatch.build.targets.wheel] artifacts` (confirmed empirically:
  hatchling's default packaging also follows `.gitignore`, same as Cargo
  and npm's default — without `artifacts`, the built wheel silently
  shipped without the file at all, a real bug this caught). All three
  still keep a `PINNED_FRONTEND_SHA256`-style checksum constant in their
  own embed code, re-verified at build/runtime, same as Go's.

`mise run frontend:check-ports-sync` verifies all five ports' checksum
pins (and Rust/Go's committed bytes) against the canonical file in CI.

## What you implement

Keyed to `spec/protocol.md` section numbers — this is the actual surface
area, everything else (UI, UX, DSL design, security model) is inherited
by reusing the frontend and fixtures above:

1. **Config + fail-closed kill switch** (§4). A bare `enabled` flag,
   defaulting to off. The port MUST NOT read, infer, or validate what
   environment the host is running in — that's the host's decision
   entirely, made outside this crate. Absent/malformed config MUST mean
   disabled, never enabled with defaults (this is hardening checklist
   item 2, and needs its own port-level test — the conformance kit can't
   observe it; see "How to run conformance" below).
2. **The HTML route** (§5.1) serving the vendored frontend, and **the
   seven API routes** (§5.2–§5.8): `tables`, `table-counts`, `tables/data`,
   `tables/common-values`, `siblings`, `schemas`, `sources`. Response
   shapes exactly as `spec/openapi.yaml` declares.
3. **Catalog queries** — table/column introspection, PK/FK metadata with
   composite FKs omitted (§5.4.1), `current_schema()` scoping throughout,
   `pg_class.reltuples` counts, `pg_stats`-based common values. An endpoint
   that performs multiple schema-sensitive queries to form one response MUST
   pin them to one database connection or transaction, so a pooled session's
   `search_path` cannot change the connected schema mid-response. **The
   text-cast serialization trap** (§5.4.3): every selected column MUST be
   cast to text *in the SQL itself*; decoding into a native type and
   reformatting in application code is non-conformant even if the end
   result happens to look like a string (see hardening checklist item 1).
4. **Filter AST validation + WHERE-clause building** (§5.4.2) — no DSL
   text parsing (that's frontend-only, `spec/filter-dsl.md`); this is
   pure JSON-AST-in, WHERE-fragment-out. Columns validated against the
   live schema allow-list exactly like `sort`; operators mapped through a
   hardcoded allow-listed table; values always bound parameters, never
   concatenated (hardening checklist item 6). Build against
   `spec/fixtures/filter-builder-tests.json` first — it's the spec.
5. **A timeout on every query** (§6) — catalog queries included, not just
   `tables/data`.
6. **The protocol version header** (§7) — `x-ashurbanipal-protocol` on
   every API response.

## What you MUST NOT do

- **Add authentication.** Perimeter security is the host's job — this
  crate inherits whatever already guards the host process.
- **Add write endpoints.** Every route is a read-only `GET`; there is no
  protocol-level story for mutation.
- **Add extra endpoints under the mount.** New functionality goes through
  a `spec/protocol.md` proposal (one PR touching spec + fixtures +
  implementations + runner together — see Governance below), not a
  port-specific extension living only in one language.
- **Fork the frontend.** Vendor the released artifact as-is; UI changes go
  upstream into `frontend/dbviewer.html` and flow back down through the
  next release tag.

## Conformance is two layers, both required

A listed port needs its own CI running two independent checks against
`spec/openapi.yaml` and `spec/protocol.md` (`docs/design.md` §4.2) — no
port is exempt from either, and this applies to the Rust implementation
too, not just ports:

1. **Behavior conformance** — the golden-fixture runner in
   `conformance/runner`, pointed at the port via `ASHURBANIPAL_CONFORMANCE_URL`.
2. **Shape conformance** — schemathesis fired at the port's own running
   instance via `conformance/runner/schema-check.sh`, asserting every
   response matches `spec/openapi.yaml`'s declared types, nullability,
   and status codes. This is language-agnostic on the target side —
   schemathesis only speaks HTTP — so every current implementation
   (Rust, Spring Boot, Go) reuses the same script rather than each
   wiring its own OpenAPI-validation tool; a port in an environment where
   installing Python/schemathesis is genuinely impractical may substitute
   an equivalent tool, but reusing `schema-check.sh` as-is is the default,
   not a Rust-only convenience.

Both checks passing is a listing prerequisite, the same bar the Rust
implementation itself has to clear — a green behavior-conformance run
alone does not prove response shape is right, and vice versa.

### How to run conformance locally

Apply the seed once against your target database:

```sh
psql "$YOUR_DSN" -f conformance/seed/seed.sql
```

Behavior conformance — **requires a Rust toolchain even when the port
under test isn't Rust**: the runner itself is a Rust test binary
(`implementations/rust/axum`'s `conformance` integration test) that drives
plain HTTP requests at whatever `ASHURBANIPAL_CONFORMANCE_URL` names, so
a port never reimplements the runner, it just needs `cargo` available to
invoke it:

```sh
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:PORT/__ashurbanipal \
  bash conformance/runner/report.sh
```

Add `ASHURBANIPAL_CONFORMANCE_SEED_DSN=$YOUR_DSN` to have the runner apply
the seed itself instead of doing it by hand first; omit it and the runner
instead verifies the `_conformance_meta` sentinel table and fails fast
with a clear message if the seed looks absent or stale (see
`conformance/seed/README.md`). Writes `conformance-report.json` (suite
version, target, pass/fail per requirement ID from
`conformance/runner/COVERAGE.md`).

Shape conformance — Python + schemathesis, no Rust toolchain needed:

```sh
ASHURBANIPAL_CONFORMANCE_URL=http://localhost:PORT/__ashurbanipal \
  bash conformance/runner/schema-check.sh
```

### How to run it in CI

`.github/workflows/_conformance-behavior.yml` and
`_conformance-schema.yml` are reusable (`workflow_call`) templates that do
the above end to end: start a Postgres service container, apply the seed,
start your demo (a `start-command` input you provide), poll a health URL,
then run the runner/schemathesis against it. `go-conformance.yml` and
`spring-boot-conformance.yml` are the concrete callers to copy from —
each just supplies its own toolchain, start-command, and health URL; the
behavior template installs a Rust toolchain internally regardless of the
port's own language, per the note above.

## CSP and inline scripts

`frontend/dbviewer.html` ships its logic as an inline `<script
type="module">` — there is no separate `.js` asset a port could point a
`<script src>` at instead, by design (`docs/design.md` §3.1: single
self-contained file, no build step). This is not framework-specific; every
port that serves the HTML route hits it identically:

- A host with a `Content-Security-Policy` that forbids inline scripts
  (no `unsafe-inline`, no matching `nonce-*`/`sha256-*` source) will serve
  the page but the browser will refuse to execute it — the UI renders as
  static markup with no data ever loading, silently. This is exactly the
  kind of security-conscious deployment this crate targets, so it is a
  likely failure mode in practice, not a hypothetical one.
- Ashurbanipal does not, and MUST NOT, weaken a host's CSP on its own
  behalf — that would be a global side effect of mounting one router.
- A port has two honest options, and must document which one it takes:
  1. **Carve out an exception** for the mount's own response only (e.g. a
     per-response CSP header override, or a nonce the port injects into
     the served HTML and into its own response header) — scoped to the
     `{mount}` route, not applied host-wide.
  2. **Document the requirement** and leave it to the operator: the host's
     own CSP configuration needs `script-src` to permit the vendored
     inline script at `{mount}` (e.g. via a nonce/hash the host adds to its
     policy for that route, or an explicit CSP exception for the mount
     path) before the UI will run under a strict CSP.
- The Spring Boot starter (`implementations/spring-boot-starter`) takes
  option 2: it sets no CSP header of its own and injects no nonce, so a
  host running under a strict CSP must extend it for `${ashurbanipal.base-path}`
  itself before the UI will execute client-side. This matches the Rust
  reference's behavior (also no CSP handling) — consistent across ports,
  not a Spring-specific gap.

## Listing bar

A port is added to the `readme.md` registry only once **all** of the
following are true — green CI is necessary, not sufficient:

1. Public CI runs the golden-fixture behavior runner (above) on every
   commit against a pinned protocol version.
2. Public CI runs the schemathesis shape check (above) on every commit.
3. The requirement neither layer can observe over HTTP — that
   absent/malformed config MUST mean disabled, never enabled with
   defaults — is covered by the port's own linked implementation tests
   (its kill-switch test file), referenced from its README.
4. The port ships its own unit and integration test suite (adapter/catalog
   queries, filter-AST validation, config parsing) beyond the conformance
   kit — conformance proves protocol compliance over HTTP, it doesn't prove
   the implementation's internals are individually tested.
5. The port's package ecosystem has a dependency-update automation entry
   (`.github/dependabot.yml`, one `package-ecosystem` block pointed at the
   port's directory) so its dependencies don't silently go stale relative
   to the other ports.
6. A named reviewer has signed off against every item in the Governance
   checklist below, for properties none of the automated layers can
   prove (injection absence, fail-closed defaults, vendoring integrity).
   Recorded in that section's sign-off log.

## Governance

- **One-PR rule.** A spec change is one PR touching: `spec/*`, fixtures,
  the affected implementation(s), and the conformance runner — never a
  subset. This is what keeps `spec/openapi.yaml` (hand-maintained, not
  generated) from drifting silently: CI enforces it via the fixture
  round-trip test and the coverage-matrix check
  (`conformance/runner/COVERAGE.md`).
- **Protocol versioning.** Additive-optional changes (a new optional
  field, a new allow-listed value) keep the same major version. Anything
  behavioral or shape-changing bumps the version and gets a migration
  note in `spec/CHANGELOG.md`.
- **Registry staleness.** Each port pins the protocol version it
  implements (the `readme.md` table's "Protocol version" column). When
  the version moves, the registry marks any row still on the old version
  as stale until that port updates.

### Cross-port hardening checklist (listing prerequisite)

A green CI run only proves two things: response shape matches
`spec/openapi.yaml`, and behavior matches the golden fixtures on the
inputs those fixtures happen to cover. Neither layer can observe the
seven properties below — they need a named reviewer to actually read the
port's source, once per port, before it's added to the registry.

1. **Cast in SQL, never in application code.** Every value-serialization
   cast (`column::text`) MUST happen in the query text itself, not by
   decoding into a native type and then calling the language's own
   `toString()`/formatting function afterward. Postgres's own cast is
   locale- and timezone-independent; a driver-level decode-then-
   restringify step can silently diverge (a JVM default locale using `,`
   for a decimal separator, a timestamp formatted without Postgres's `+00`
   suffix) while still technically satisfying "all values are JSON
   strings."
2. **Fail-closed is the default, not just the rejection rule.** Every
   config-loading auto-detection convenience (classpath-presence
   autoconfiguration is the obvious risk, but this generalizes) tends to
   bias toward "found on the classpath, no explicit config → sensible
   defaults, turned on." That's backwards here: absent or malformed
   kill-switch config MUST result in disabled, never enabled. Verify with
   a port test asserting the *no-config* case specifically.
3. **Vendoring integrity is a per-port CI check, not a one-time release
   fact.** Covered above under "Vendoring the frontend," step 4 — the
   port's own CI must re-hash the file it actually ships on every build,
   not just record the hash once at vendoring time.
4. **CSP/inline-script is a documented integration requirement.** Covered
   above under "CSP and inline scripts" — the port must state which of
   the two options (carve out an exception, or document the requirement)
   it takes.
5. **Kill-switch verification can't stop at self-certification.** The
   conformance kit explicitly can't observe absent-config-means-disabled
   over HTTP — it's process-startup behavior, not a response. The port's own
   kill-switch test is the only evidence this property holds at all, so
   it needs a named reviewer to have actually read and run that test
   (not just trusted a green checkmark) before a port is listed — the
   single highest-consequence, weakest-automatically-verified property in
   the system.
6. **A green conformance run never proves the absence of injection.** A
   port that builds its WHERE clause via string interpolation instead of
   parameterization can still pass every fixture if the included
   adversarial payloads don't happen to trigger that exact path —
   black-box HTTP testing can't prove a negative. Requires an explicit
   query-construction code review: every identifier is allow-list-checked
   against the live schema, every value is bound, nothing is ever
   concatenated.
7. **Catalog SQL is diffed against `postgres.rs`, not independently
   "reimplemented."** The `information_schema`/`pg_stats` queries are
   hand-copied per language, in each language's own SQL dialect quirks.
   Require the port's catalog-query section of its PR to include a
   side-by-side diff against the reference's actual queries in
   `implementations/rust/core/src/db/postgres.rs`, not just a description
   of what it does — the fixture-driven conformance kit catches
   *behavioral* drift here but doesn't make this review step optional.

### Sign-off log

One row per port, filled in when a reviewer has actually confirmed items
1–7 above (not merely inferred them from the port's own tests passing).
Items 3 and 4 are largely mechanical (checked by re-reading the sections
above against the port's actual CI config and served HTML); items 1, 2,
5, 6, and 7 require reading the port's source directly.

| Port | 1. cast-in-SQL | 2. fail-closed default | 3. vendoring re-hash | 4. CSP documented | 5. kill-switch test read | 6. no injection | 7. catalog diffed vs `postgres.rs` | Reviewer |
|------|----------------|-------------------------|-----------------------|--------------------|----------------------------|-------------------|-------------------------------|----------|
| `implementations/rust` | n/a — reference | ✅ (see note) | n/a — nothing to vendor | n/a — origin of the requirement | ✅ | ✅ | n/a — reference | Claude (AI-assisted), 2026-07-25 |
| `implementations/spring-boot-starter` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Claude (AI-assisted), 2026-07-25 |
| `implementations/go-nethttp` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Claude (AI-assisted), 2026-07-25 |
| `implementations/node-express` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | MT (human review, merged PR #12); Claude (AI-assisted re-verification), 2026-08-04 |
| `implementations/flask-python` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Claude (AI-assisted), 2026-08-09 |

Note on the Rust row, item 2: at the time of this sign-off, the reference
had no test for the specific "config key absent from the TOML text
entirely" case (only for an explicitly empty value, constructed directly
in Rust) — added a test to close that gap. The kill switch was later
redesigned from an `environment`/`enabled_for` allow-list to a bare
`enabled: bool` (`spec/protocol.md` §4); the surviving test covering this
same absent-key case is `config::tests::disabled_when_config_absent`.

These rows are AI-assisted, not a substitute for the human sign-off item
5 itself calls for — a named human reviewer should still read and run
each port's kill-switch test before treating any port as listed under
the bar above.
