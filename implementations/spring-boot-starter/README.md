# Ashurbanipal Spring Boot starter

Kotlin/Spring Boot autoconfiguration starter implementing `spec/protocol.md`
— see the repo root `readme.md` for what this is and `PORTING.md` for what a
port implements/reuses.

## Database support

| Backend | Type | Status |
|---|---|---|
| Postgres (`PostgresSource`) | default, no config needed | Conformant — covered by the full conformance suite (`spring-boot-conformance.yml`). |
| MySQL/MariaDB (`MySqlSource`) | opt-in via `ashurbanipal.backend=mysql` (off by default) | Reviewed and supported, with known degraded features — common-values statistics have no reliable cross-version equivalent and degrade to empty. Table counts and comments come from `information_schema`, same as Postgres. Detects MySQL vs. MariaDB at runtime (`SELECT VERSION()`, cached) since the two forks need different query-timeout SQL — see `docs/adapter-decisions.md` §6. Not run through `conformance/runner` (that suite targets Postgres); has its own unit test suite instead, requiring a live instance via `MYSQL_TEST_URL`/`MARIADB_TEST_URL`. |
| SQLite (`SqliteSource`) | opt-in via `ashurbanipal.backend=sqlite` (off by default) | Reviewed and supported, with known degraded features — comments and common-values statistics have no SQLite equivalent and degrade to empty/omitted; table counts are always the "no estimate" sentinel rather than Postgres's fast planner estimate. The real query-timeout mechanism is Xerial `sqlite-jdbc`'s `org.sqlite.ProgressHandler`, not plain JDBC `Statement.setQueryTimeout` (verified empirically not to cancel a running query on this driver — see `docs/adapter-decisions.md` §6). Not run through `conformance/runner`; has its own unit test suite instead. |

Selecting a backend is always an explicit config property, never inferred
from which JDBC driver happens to be on the classpath (`PORTING.md`'s
hardening checklist item 2 — classpath-presence autoconfiguration is this
project's highest-risk default failure mode). A host opting into
`mysql`/`sqlite` still supplies its own `DataSource` bean (pointed at that
engine) exactly as it would for Postgres; this starter never adds a JDBC
driver dependency of its own (`org.xerial:sqlite-jdbc` is `compileOnly` in
`build.gradle.kts`, needed only to compile `SqliteSource`'s use of the real
timeout mechanism — the host's own runtime classpath must provide it if
`backend=sqlite` is set, which it needs anyway to build a working
`DataSource`).

```yaml
ashurbanipal:
  environment: ${ASHURBANIPAL_ENVIRONMENT:dev}
  enabled-for: ${ASHURBANIPAL_ENABLED_FOR:dev}
  # Defaults to "postgres"; "mysql" (covers MariaDB too) or "sqlite" opt in
  # to the alternate DbSource implementations above.
  backend: postgres
```

See `docs/adapter-decisions.md` for the full per-backend mechanism registry
(row counts, common-values, text casting, `ILIKE` mapping, schema scoping,
comments, query timeouts) shared across every implementation in this repo.
