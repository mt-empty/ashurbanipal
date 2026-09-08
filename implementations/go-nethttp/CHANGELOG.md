# Changelog

Notable changes to the Go/net-http port. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The shared protocol
version is tracked separately in `spec/CHANGELOG.md`. Changes before 0.3.0 are
not tracked here — see the git history.

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
