# Porting Ashurbanipal

Status: draft — only the vendoring contract exists so far (Phase 3). The
full checklist (what a port implements, what it reuses, the conformance
bar, governance) lands in Phase 6, written from a second implementation's
actual experience rather than speculation — see `implementation.md`.

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
4. Re-verify the hash in your own CI on every build — per
   `implementation.md`'s cross-port hardening checklist, a build pipeline
   (bundler, resource filtering) can silently mangle the vendored file
   without anyone touching this repository's code. Don't just record the
   hash once at vendoring time and trust it forever after.

Since the frontend is the single canonical implementation of the filter
grammar parser (`spec/filter-dsl.md`), vendoring it pins filter *syntax*
compatibility, not just UI/UX — treat a version bump here with the same
care as a `spec/protocol.md` version bump.

## Conformance is two layers, both required

A listed port needs its own CI running two independent checks against
`spec/openapi.yaml` and `spec/protocol.md` (`docs/design.md` §4.2) — no
port is exempt from either, and this applies to the Rust implementation
too, not just future ports:

1. **Behavior conformance** — the golden-fixture runner in
   `conformance/runner`, pointed at the port via `ASHURBANIPAL_CONFORMANCE_URL`.
2. **Shape conformance** — a property-based OpenAPI check fired at the
   port's own running instance, asserting every response matches
   `spec/openapi.yaml`'s declared types, nullability, and status codes.
   The Rust implementation's instance is schemathesis
   (`conformance/runner/schema-check.sh`, wired into
   `.github/workflows/conformance-rust.yml`'s `schema-conformance` job); a port
   in a non-Python stack wires an equivalent tool for its own language
   (e.g. a JVM OpenAPI-validation library for a Spring Boot port) rather
   than shelling out to schemathesis. Either way it fires against
   `spec/openapi.yaml` as published — no port owns or forks that file.

Both checks passing is a listing prerequisite, the same bar the Rust
implementation itself has to clear — a green behavior-conformance run
alone does not prove response shape is right, and vice versa.

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
