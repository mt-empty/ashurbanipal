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
   `.github/workflows/conformance.yml`'s `schema-conformance` job); a port
   in a non-Python stack wires an equivalent tool for its own language
   (e.g. a JVM OpenAPI-validation library for a Spring Boot port) rather
   than shelling out to schemathesis. Either way it fires against
   `spec/openapi.yaml` as published — no port owns or forks that file.

Both checks passing is a listing prerequisite, the same bar the Rust
implementation itself has to clear — a green behavior-conformance run
alone does not prove response shape is right, and vice versa.
