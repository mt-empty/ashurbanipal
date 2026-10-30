# Changelog

Notable changes to the Python/Flask port. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The shared protocol
version is tracked separately in `spec/CHANGELOG.md`. Changes before 0.3.0 are
not tracked here — see the git history.

## [0.12.0] - 2026-10-30

### Bug Fixes

- *(frontend)* Keep the table chips from rewrapping when a scrollbar appears (#222)

### Performance

- Faster start-up — send requests together, prefetch likely views, gzip the page (#221)

## [0.11.0] - 2026-10-28

### Features

- *(protocol)* [**breaking**] Report the default source and schema (#210)

### Bug Fixes

- *(frontend)* Rely on the browser's back/forward and add a history entry per applied change (#196)
- *(mysql)* Sort catalog lists by byte order and keep MariaDB JSON unjoinable (#213)
- *(frontend)* Key remembered settings by concrete source and schema (#214)

### Refactor

- *(frontend)* Retire sidebar-era names for the table chips (#197)
- *(frontend)* Rename sidebar.ts and nav.ts after what they hold (#201)

## [0.10.0] - 2026-10-24

### Features

- *(frontend)* Mark start-up busy, keep the active chip visible, honour reduced motion, and speed up the e2e suite (#191)

### Bug Fixes

- *(frontend)* Keep the filter suggestions over the countdown bar and remember an expanded table list (#185)
- *(frontend)* Group the columns menu by table and make header sort keyboard-reachable (#186)
- *(frontend)* Switch views only once their data arrives, and lock the old grid when a switch cannot wait (#187)
- *(frontend)* Keep the title row and copy buttons steady when a glyph comes from a fallback font (#189)

### Security

- *(deps)* Refresh every port's dependencies and patch open advisories (#190)

## [0.9.0] - 2026-10-22

### Features

- *(frontend)* Opt-in auto-refresh and a visible loading bar (#182)

### Bug Fixes

- *(frontend)* Open suggestion lists with no row highlighted so Enter submits (#183)

## [0.8.0] - 2026-10-22

### Features

- *(siblings)* Switch environments from Other services, with a fallback note (#173)
- *(frontend)* Table and saved-join chips are real links (#174)

### Refactor

- *(frontend)* Share one view-URL builder between history and chip links (#179)

## [0.7.0] - 2026-10-21

### Features

- Migrate error bodies to RFC 9457 problem+json (spec/protocol.md §2) (#123)
- Add GET /api/tables/structure (§5.10) across all ports (#148)
- *(frontend)* Redesign layout with top table chips, quieter grid and filter assist (#147)
- *(join)* Add the server-side table join route to all five ports (#153)
- *(join)* [**breaking**] Build, browse and save joins in the browser; Flask requires Python 3.12 (#154)

### Bug Fixes

- *(join)* Review follow-ups — view renames, load race, Flask 500 on lone surrogates (#164)

### Security

- Send X-Content-Type-Options: nosniff on API responses (#170)

## [0.6.0] - 2026-09-13

### Bug Fixes

- Reject a NUL byte in table/filter-value params, not a raw 500 (#120)

### Security

- Add incoming FK references endpoint (§5.9) (#119)

## [0.5.0] - 2026-09-08

### Features

- *(frontend)* Remember the selected schema per source (#90)
- *(frontend)* Copy a record-view row as a SQL INSERT statement (#87)
- *(frontend)* Persist the applied filter in the URL, not localStorage (#92)
- *(frontend)* Tolerant cross-engine column-type rendering (#101)

### Bug Fixes

- *(frontend)* Sync the AI-agent API reference and fix the copy-icon width (#94)
- *(frontend)* Doc sync, deeper API-reference fixes, and filter-op/localStorage type safety (#95)

### Refactor

- *(frontend)* Dedupe and simplify frontend/src (#93)
- *(frontend)* Architecture pass — cycle break, linting, drift guards, unit tests (#96)
- *(frontend)* Group src/ into bootstrap/core/features/lib layers (#97)
- *(frontend)* Split row-diff and json-tree into pure units + unit tests (#98)
- *(frontend)* Add console.warn/error at silent failure points (#100)

### Documentation

- *(ports)* Cull replicated comment prose (#77)

## [0.4.0] - 2026-08-30

### Features

- *(frontend)* Refresh button — new-row highlight + per-table sort memory (#71)

### Security

- Per-port changelogs and GitHub Releases via git-cliff (#70)

### Refactor

- Replace legacy "dbviewer" naming in the siblings interface (#74)

## [0.3.0] - 2026-08-28

First release with a tracked changelog. Implements protocol v1.
