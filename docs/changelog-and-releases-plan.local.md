# Plan: per-port changelogs + GitHub Releases (no backfill)

> Untracked working doc (`docs/*.local.md` convention). Not committed. Delete or
> promote to `docs/feature-backlog/` once the change lands.

## Status: implemented on branch `changelog-and-releases` (WIP commits, not reviewed/pushed)

All five phases are in the working tree and committed locally (WIP commits — a
stray `git reset --hard` during testing wiped the tree once, so the work is
checkpointed now; reword/squash freely). Validated locally:
- all 26 workflow YAML files parse
- `mise run changelog:check` and `mise run docs:check-versions` pass
- `cliff.toml` produces clean, forward-only, **per-port-scoped** output against
  isolated fixtures (`--include-path` multi-glob scoping verified; an axum-only
  commit reaches `changelog:rust-axum`, not `changelog:node-express`)
- the `_post-release.yml` run block (`set -f` → `git-cliff --current` →
  `${GITHUB_REF_NAME##*v}` → `gh release`) verified for the axum and Go tag shapes
- the 6 `*-publish.yml` `post-release` jobs collapsed into one reusable
  `_post-release.yml` (repo's `_*.yml` convention)

### Manual steps the repo can't do (you)

1. **GitHub → Settings → General → Pull Requests**: allow **squash merging only**
   (disable merge commits + rebase). `pr-title-lint.yml` only shapes `main`'s
   history under squash-merge.
2. **GitHub → Settings → Environments** — for `crates-io-publish`, `npm-publish`,
   `pypi-publish`, `maven-central-publish`: if any has a "Deployment branches and
   tags" allowlist pinned to the old tag patterns (`core-v*`, `axum-v*`, …),
   change it to the new `ashurbanipal-*-v*` patterns, or the renamed tags will be
   blocked from deploying and publish will fail.
3. **Registry trusted-publisher configs** (crates.io / npm / PyPI): confirm none
   pins an optional ref/tag filter that names an old prefix. Trust is keyed on
   repo + workflow filename + environment (all unchanged), so this is a
   double-check, not expected to bite.
4. First release under each new prefix: `--current`/`--unreleased` use a
   single-prefix `--tag-pattern`, so with no prior new-prefix tag the range runs
   from repo root. That is fine — `filter_unconventional` drops all pre-CC
   commits, so the first `ashurbanipal-<name>-v*` Release notes contain only the
   Conventional-Commit commits landed since CC adoption.

## Context

Ashurbanipal publishes 7 artifacts (3 Rust crates → crates.io, Node → npm, Flask
→ PyPI, Spring → Maven Central, Go → proxy.golang.org) from one monorepo, on
per-port directory-scoped tags that trigger per-port publish workflows. Today
there is no per-release changelog and no GitHub Release is created — only
`spec/CHANGELOG.md` (protocol version, hand-written) exists. Consumers using
Dependabot get no "Release notes" or "Changelog" section in their update PRs
because neither GitHub Releases nor a discoverable changelog file exists.

Goal: give each published port a `CHANGELOG.md` and a GitHub Release per tag,
generated with **git-cliff** wired into the existing tag→publish pipeline (not
release-please — its independent-versioning + release-PR model fights this repo's
shared-`major.minor` policy). **No history backfill**: git-cliff's `--include-path`
is blind to the pre-0.3.0 Rust workspace restructure, the per-port `*-v*` tags are
shared-SHA tags (every `*-v0.3.0` peels to one commit), and 37 of the recent
commits are not Conventional Commits. So 0.3.0 is a hand-written floor and
git-cliff only ever generates `> 0.3.0`.

This plan was pressure-tested with a bug review and with empirical git-cliff
2.13.1 runs against this repo; the fixes from that review are folded in below and
the residual risks are in **Open issues**.

**Decisions locked** (from planning Q&A): the Phase 4 tag-prefix rename ships in
**this same change**, not a follow-up; GitHub Releases are **forward-only** (no
backfill for the existing `*-v0.3.0` tags); the 3 Rust crates get **one
`CHANGELOG.md` each**.

---

## Phase 1 — Tooling + config

1. **`mise.toml` `[tools]`**: add `"aqua:orhun/git-cliff" = "2"` (or `latest`). It is
   not installed in CI or the devcontainer today; nothing in Phase 2/3 runs without it.

2. **Root `cliff.toml`**:
   - Keep a Changelog output, `[git] conventional_commits = true`,
     **`filter_unconventional = true`** (drop non-CC commits rather than dump raw
     subjects — verified: `false` pulls in `Merge pull request #NN …` noise).
   - `commit_parsers` for the standard CC types → Features / Bug Fixes / Security /
     Performance / Documentation / Miscellaneous.
   - `tag_pattern` left unset here; each invocation passes `--tag-pattern`.
   - **No `[remote]` section by default.** A `[remote.github]` block (for PR links)
     is added only in the release-time job, with `GITHUB_TOKEN` in env — keep it
     out of anything `mise run check` touches so no network call leaks into the
     offline aggregate.

3. **Seven `CHANGELOG.md` files**, each seeded with a single hand-written
   `## [0.3.0] - <date>` section (the current published state — 2–4 lines,
   written from `docs/publishing-checklist.md` + `spec/CHANGELOG.md`, not
   generated):
   - `implementations/rust/core/CHANGELOG.md`
   - `implementations/rust/axum/CHANGELOG.md`
   - `implementations/rust/actix-web/CHANGELOG.md`
   - `implementations/node-express/CHANGELOG.md`
   - `implementations/flask-python/CHANGELOG.md`
   - `implementations/spring-boot-starter/CHANGELOG.md`
   - `implementations/go-nethttp/CHANGELOG.md`
   Header of each: "Entries below 0.3.0 are not tracked here; see git history."

4. **Ship the file in the packaged artifact** (cheap, and lets npm/PyPI surface it):
   - Node `implementations/node-express/package.json`: add `"CHANGELOG.md"` to the
     `files` array (currently `dist, src, demo, frontend/dbviewer.html, tsconfig.json`).
     `repository.directory` is **already** set — no change there.
   - Flask `implementations/flask-python/pyproject.toml`: the wheel is
     `packages = ["ashurbanipal"]`, so a repo-root-relative `CHANGELOG.md` is
     **not** included by default — add
     `[tool.hatch.build.targets.wheel.force-include]` mapping
     `"CHANGELOG.md" = "ashurbanipal/CHANGELOG.md"` (or place the file under the
     package dir).
   - Rust crates: `cargo publish` includes `CHANGELOG.md` next to `Cargo.toml` by
     default — just don't add it to any `exclude`.
   - Spring: Maven Central won't surface it; skip packaging, keep the repo file.

5. **`spec/CHANGELOG.md`**: add one line under its header pointing to the per-port
   `implementations/*/CHANGELOG.md` for implementation-level changes.

## Phase 2 — Generation tasks + drift guard

6. **`mise.toml` tasks** — one `changelog:<port>` per port (7), a `changelog`
   umbrella (→ `changelog:check`), and `changelog:check`. Each port task **prints
   the unreleased section to stdout** for a human to paste under a new `## [X.Y.Z]`
   heading at release time — no `--prepend`, no file write (git-cliff can't
   reproduce the hand-written floor, so an automated rewrite would fight it). E.g.
   for axum:
   ```
   git-cliff --unreleased --strip header \
     --tag-pattern '^ashurbanipal-axum-v' \
     --include-path 'implementations/rust/axum/**' 'implementations/rust/core/**' 'frontend/**' 'spec/**'
   ```
   - `--tag-pattern` is a **single prefix** (`^ashurbanipal-axum-v`), never an
     alternation — testing showed `git-cliff --current` errors ("No suitable tags
     found") on any `^(a|b)` pattern. The retired `axum-v*` tags are simply
     invisible to the new pattern; harmless because `filter_unconventional` drops
     every pre-Conventional-Commits commit, so there is no real history to orphan.
   - `frontend/**` + `spec/**` in every port's `--include-path` (needed for
     node/flask/spring, which vendor `dbviewer.html` ephemerally; harmless for the
     rest). Rust adapters also include `implementations/rust/core/**` — a core-crate
     change alters the published adapter's behaviour. `--include-path` with
     multiple globs scopes correctly per port (verified in an isolated fixture:
     an axum-only commit shows in `changelog:rust-axum`, not `changelog:node-express`).
   - Go tag pattern stays `^implementations/go-nethttp/v` (needs the module path).
   - `cliff.toml` **drops `chore`/`ci`/`build`/`style`/`test`** commits (Keep a
     Changelog is "for humans" — dependency bumps and CI tweaks are noise). Only
     `feat`/`fix`/`perf`/`docs`/`refactor`/security/revert reach a CHANGELOG.

7. **Drift guard — NOT regeneration.** Do **not** regenerate + `git diff` in
   `mise run check`: a changelog is a function of ever-growing git history, so
   that gate reddens on every PR after a release, and git-cliff can never
   reproduce the hand-written 0.3.0 floor anyway. `tools/check-changelogs.sh`
   (wired in as `changelog:check`, under the `changelog` umbrella, in
   `[tasks.check]`) does a cheap deterministic offline check instead: each
   `implementations/<port>/CHANGELOG.md`'s top `## [x.y.z]` heading must equal
   that port's manifest version (`Cargo.toml` / `package.json` / `pyproject.toml`
   / `build.gradle.kts`; Go has no manifest, file-shape only). A top section of
   `## [Unreleased]` is allowed and skipped. No CI job runs `mise run check`
   today, so this is a local guard — acceptable for a release-time artifact.

## Phase 3 — GitHub Releases from the publish workflows

8. **New reusable `_post-release.yml`**, called as a `post-release` job by every
   `*-publish.yml` — **a separate job, `needs: publish`**, never folded into the
   `publish` job:
   - `publish` jobs use bare `actions/checkout@v7` (`fetch-depth: 1`, no tags) —
     `flask-python-publish.yml`'s `publish` job does no checkout at all — and hold
     a locked-down `permissions: { contents: read, id-token: write }` for OIDC
     trusted publishing. Editing that block risks dropping `id-token: write` and
     breaking every Rust/Node/Flask release. Those jobs are left untouched.
   - `_post-release.yml` (`permissions: contents: write`, no `id-token`) does
     `actions/checkout@v7` with `fetch-depth: 0` + `fetch-tags: true`,
     `jdx/mise-action` with `install_args: git-cliff` (that tool only, not the
     whole `mise.toml` toolchain), then `set -f` (keep the globs literal) →
     `git-cliff --current --strip header --tag-pattern <input> --include-path
     <input…> > NOTES.md` → `gh release create … --verify-tag || gh release
     edit …`. `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
   - Callers run it `continue-on-error: true` — an irreversible registry publish
     already happened in `needs: publish`; a Releases hiccup must not wedge a
     completed release, and `|| gh release edit` makes a manual re-run idempotent.
   - Inputs: `tag-pattern` (single prefix), `include-paths` (space-separated
     globs), optional `title-prefix` (Go passes `"go/net-http "`).
   - Version for the title is `${GITHUB_REF_NAME##*v}` — verified to strip every
     port prefix (no prefix segment or semver contains a lone `v`), so the Go
     slashy ref works too.

9. **New `.github/workflows/go-nethttp-publish.yml`** — Go had no publish workflow
   (the pushed tag was the release). Triggers on `implementations/go-nethttp/v*`;
   runs a Go build + conformance gate mirroring `go-conformance.yml`, then calls
   `_post-release.yml`. No registry step (proxy.golang.org just indexes the tag).

10. **`docs/publishing-checklist.md` — "Cutting a release"**: adds a step before
    tagging — run `mise run changelog:<port>`, review the `## [Unreleased]`
    section, paste it under the target-version heading, commit in the release
    commit — and notes that pushing the tag now also creates a GitHub Release.

## Phase 4 — Tag-prefix rename (ships in this change)

Needed so Dependabot attaches the right port's Release notes: it filters releases
to those whose tag starts with the exact package name, else falls back to *all*
releases and picks an arbitrary one matching the version (every `*-v0.3.0` shares
the number). Current `axum-v*` etc. never match `ashurbanipal-axum`.

11. Rename prefixes going forward:
    | Port | Old | New |
    |---|---|---|
    | Rust core | `core-v*` | `ashurbanipal-v*` |
    | Rust/Axum | `axum-v*` | `ashurbanipal-axum-v*` |
    | Rust/Actix | `actix-web-v*` | `ashurbanipal-actix-web-v*` |
    | Node | `node-v*` | `ashurbanipal-node-express-v*` |
    | Flask | `flask-v*` | `ashurbanipal-flask-v*` |
    | Spring | `spring-v*` | `ashurbanipal-spring-boot-starter-v*` |
    | Go | `implementations/go-nethttp/v*` | unchanged (needs the module-path prefix) |

12. Update, in the same change:
    - each workflow `on.push.tags` and the `tag-prefix:` input passed to
      `_rust-crate-publish-check.yml`, plus the prefix-strip expressions in the
      `verify-version` jobs.
    - `_rust-crate-publish-check.yml` prefix handling.
    - **`tools/check-doc-versions.sh:54`** — `git tag -l 'spring-v*'` becomes
      `git tag -l 'ashurbanipal-spring-boot-starter-v*'`. Without this the
      ledger-vs-tag guard silently takes its "no tags reachable; skipping" branch
      and stops checking. Consider making it *fail* (not skip) once a
      new-prefix tag exists.
    - `docs/publishing-checklist.md` "What's published" table + Conventions.
    - the `--tag-pattern` in the mise tasks (drop the `(ashurbanipal-)?`
      optionality after the first release under each new prefix).
    - a grep of `readme.md`, `docs/`, `PORTING.md` for the old prefixes.
13. Add a tiny workflow that **fails loudly** on a pushed old-prefix tag
    (`axum-v*`, …) so a muscle-memory `git tag axum-v0.4.0` doesn't silently no-op.

## Phase 5 — Conventional Commits going forward

14. Add a PR-title lint (`amannn/action-semantic-pull-request` or a short grep
    workflow) so squash-merge commit subjects are CC-formatted. **Confirm the repo
    merges via squash** first (recent history shows merge commits like
    "Merge pull request #68" — if merges aren't squashed, the PR-title lint does
    nothing for git-cliff and per-commit CC discipline is needed instead).
15. Note the convention in `PORTING.md` / a `CONTRIBUTING` section.

---

## Files touched (summary)

- **New**: `cliff.toml`, `tools/check-changelogs.sh`,
  7 × `implementations/*/CHANGELOG.md`, `.github/workflows/go-nethttp-publish.yml`,
  old-prefix-tag guard workflow, PR-title-lint workflow,
  `docs/changelog-and-releases-plan.local.md` (untracked).
- **Edited**: `mise.toml` (git-cliff tool + `changelog:*` tasks + `check` dep),
  6 × `*-publish.yml` (add `post-release` job; Phase 4 also edits triggers +
  comments + the `tag-prefix:` input Rust passes to `_rust-crate-publish-check.yml`),
  `tools/check-doc-versions.sh`, `docs/publishing-checklist.md`, `spec/CHANGELOG.md`,
  `implementations/node-express/package.json`,
  `implementations/flask-python/pyproject.toml`.
- **Not touched**: `readme.md` and `PORTING.md` carry no tag-prefix strings
  (grep confirmed) — no change needed there.

## Verification

1. `mise install` (picks up git-cliff), `mise run changelog` — confirm each
   `implementations/*/CHANGELOG.md` gets a plausible `## [Unreleased]` from
   forward history only, no pre-0.3.0 dump, no network call.
2. `mise run changelog:check` — passes on a clean tree; hand-edit a released
   `## [0.3.0]` section and confirm it fails.
3. `mise run check` — still green; confirm no new network dependency and that
   `docs:check-versions` still runs.
4. Dry-run the `post-release` job locally with `act` **or** on a throwaway
   pre-release tag on a fork: confirm `git cliff --current` resolves the tag under
   `fetch-depth: 0`, `gh release create` makes the Release, and a second run hits
   the `|| gh release edit` path without error.
5. Push a real patch release for one port (e.g. Flask) end to end: registry
   publish unaffected, GitHub Release appears with correct title + notes,
   `CHANGELOG.md` shipped in the artifact.
6. After that release, open a Dependabot PR (or inspect
   `dependabot-core`'s metadata finder against the repo) to confirm the
   "Release notes" section populates for the renamed-prefix tag.

---

## Resolved in planning

- **Tag-prefix rename**: ships in this change (Phase 4), not deferred.
- **Retroactive Releases**: no — forward-only from the next tag push.
- **Rust changelogs**: three, one per crate.

## Open issues / decisions needed

1. **Maven can't be fixed the same way.** Dependabot's dependency name for Spring
   is `io.github.mt-empty:ashurbanipal-spring-boot-starter` — not a usable tag
   prefix. Its "Release notes" match stays best-effort (first `x.y.z` release).
   Accept, or investigate whether Dependabot uses artifactId alone.
2. **crates.io / Maven get no "Changelog" (committed-file) section** — Dependabot
   only reads a repo-root or `docs/` changelog for those ecosystems, not a
   subdirectory one, and there's no metadata field to redirect it. Those two rely
   on the "Release notes" section only. Confirm that's acceptable rather than
   maintaining a root aggregate `CHANGELOG.md`.
3. **Who writes the 0.3.0 floor entries, and how terse?** They're hand-authored
   from `docs/publishing-checklist.md` + `spec/CHANGELOG.md`. Proposal: 2–4
   bullets per port, identical shared-feature text, plus any port-local 0.x.y
   patch notes already recorded.
4. **`filter_unconventional = true` means pre-CC merge commits vanish from
   generated notes.** With CC enforced from now on this self-heals within a
   release or two. If the first post-0.3.0 release lands before CC enforcement,
   its generated notes may be thin and need hand-editing (the checklist step in
   Phase 3.10 already assumes a review pass).
5. **Merge strategy is permissive — PR-title lint alone is not enough.** The repo
   allows merge-commit, squash, *and* rebase (`gh api repos/mt-empty/ashurbanipal`);
   recent history uses real merge commits ("Merge pull request #68"). A PR-title
   lint only shapes the commit that reaches `main` when a PR is squash-merged. To
   make git-cliff reliable, pick one: (a) set the repo to squash-only + PR-title
   lint, or (b) keep the current strategies but add a **commitlint on every commit
   in a PR**. Decision needed before Phase 5.
6. **`[remote.github]` API call in the `post-release` job** adds a dependency on
   `api.github.com` reachability + `GITHUB_TOKEN` scope for PR-link enrichment.
   Low risk (same job already calls `gh`), but it's a new failure mode on a
   `continue-on-error` job — enrichment failures would be silent. Acceptable?
