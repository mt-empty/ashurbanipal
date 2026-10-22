# Changelog

Notable changes to the `ashurbanipal` core crate (framework-agnostic config, `DbSource`, filter AST). Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The shared protocol
version is tracked separately in `spec/CHANGELOG.md`. Changes before 0.3.0 are
not tracked here — see the git history.

## [0.9.0] - 2026-10-22

### Changed

- No changes in this crate; version aligned with the 0.9.0 release of the other ports.

## [0.8.0] - 2026-10-22

### Features

- *(siblings)* Switch environments from Other services, with a fallback note (#173)

## [0.7.0] - 2026-10-21

### Features

- Migrate error bodies to RFC 9457 problem+json (spec/protocol.md §2) (#123)
- Add GET /api/tables/structure (§5.10) across all ports (#148)
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

- *(frontend)* Tolerant cross-engine column-type rendering (#101)

### Documentation

- *(ports)* Cull replicated comment prose (#77)

## [0.4.0] - 2026-08-30

### Security

- Per-port changelogs and GitHub Releases via git-cliff (#70)

### Refactor

- Replace legacy "dbviewer" naming in the siblings interface (#74)

## [0.3.0] - 2026-08-28

First release with a tracked changelog. Implements protocol v1.
