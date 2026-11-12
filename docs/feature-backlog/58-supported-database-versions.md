# Supported database versions

> **Status:** OPEN · **Area:** ports, conformance, infra, docs

## 1. The ask

Decide which versions of each database engine Ashurbanipal supports. Then
state that range in one place and test both ends of it in CI.

Today no range is stated anywhere, and CI tests only one version of each
engine, through floating tags ([[57-testing-environment-gaps]] V1 and V2).
Nobody can say whether a catalog query works on an older server until a
user reports that it doesn't. The B1 work in
[[33-spec-hardening-review-findings]] nearly shipped a Postgres query that
fails on Postgres 13 and older (`'anymultirange'::regtype`), and nothing
would have caught it.

## 2. Proposed range

| Engine | Minimum | Newest tested | Why this minimum |
|---|---|---|---|
| Postgres | **14** (decided 2026-11-12) | 18 | Multiranges (`anymultirange`) arrived in 14. 13 lost vendor support in Nov 2025. |
| MySQL | **8.0.13** | 8.4 LTS, then 9.x | `adapter-decisions.md` §5.10 already requires 8.0.13 (`statistics.expression`). 8.0 lost vendor support in Apr 2026, but many hosts still run it. |
| MariaDB | **10.11** | 11.8 LTS | 10.6 lost vendor support in mid-2026. 10.11 and 11.4 are LTS releases. |
| SQLite | **3.16**, to be confirmed | the version each driver bundles | The `pragma_*` table-valued functions need 3.16 (`adapter-decisions.md` §5.9). |

Check every end-of-support date against the vendor's own page before you
write the range down. The dates above are from memory.

**Postgres 14 is about to lose vendor support** (Nov 2026). The minimum is
14 because that is the oldest version our queries need. It is not a promise
to support 14 forever. The policy in §3 decides when the minimum moves up.

**SQLite differs by port.** Rust (sqlx), Go (mattn/go-sqlite3), Node
(better-sqlite3) and Spring (xerial) bundle their own SQLite, so the
version moves only when a dependency is bumped. Flask uses Python's
`sqlite3`, which links whatever SQLite the system or the Python build has.
Debian 12 ships 3.40, Ubuntu 22.04 ships 3.37, and RHEL 8 ships 3.26. So
the SQLite minimum only matters for Flask. It must be at least the newest
feature any port's SQL uses, which nobody has checked yet.

## 3. Policy to decide

Proposed rule: **every version the vendor still supports is supported.
Older versions stay supported while our queries still work on them.** Once
the vendor drops a version, a release may raise the minimum past it when a
query needs a newer feature, and that release's CHANGELOG says so.

Raising a minimum is a change for hosts, not for the wire contract. It does
not bump the protocol version.

## 4. Work

1. **State the range.** Put the table in `readme.md` and link to it from
   each port's README. Record each engine's query-level limits (like
   `indnkeyatts` needing 11, or `anymultirange` needing 14) in
   `docs/adapter-decisions.md` next to the mechanism that needs them.
2. **Pin the CI images.** Replace `postgres:18-alpine`, `mysql:8` and
   `mariadb:11` with exact minor tags, so CI cannot change engine version
   without a commit. Dependabot can then bump them.
3. **Test both ends.** Add the minimum version of each engine to the
   conformance matrix, next to the newest. Start with one port, chosen in
   §6, to keep CI time down. Every port already runs the newest version.
4. **Find the real SQLite minimum.** List the SQLite features each port's
   SQL uses, and run Flask's tests against that SQLite version.
5. **Add a `PORTING.md` checklist item.** A new catalog query must work on
   every engine's minimum version.

## 5. What "done" means

- `readme.md` states the supported range for all four engines.
- CI runs conformance against the minimum and newest version of each
  engine, with pinned image tags.
- `PORTING.md` makes the range part of the porting checklist.

## 6. Open questions

- **Which ports run the minimum versions?** All five ports times four
  engines doubles the conformance jobs. One port per engine is cheaper, but
  each port has its own SQL. One option is all ports on the minimum
  version, run only on `main` and nightly.
- **Is MySQL 8.0 worth keeping?** It has no vendor support, but it is still
  common on managed hosting. Dropping it would allow MySQL 8.4-only
  features.
- **MySQL 9.x:** test it now as the "newest", or wait for the next LTS?
- **PGlite** (the live demo) tracks one Postgres version. It needs no
  range, but it must stay at or above the minimum.
