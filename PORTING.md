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
