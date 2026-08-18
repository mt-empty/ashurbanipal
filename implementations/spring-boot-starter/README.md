# Ashurbanipal Spring Boot starter

Kotlin/Spring Boot autoconfiguration starter implementing `spec/protocol.md`
— see the repo root `readme.md` for what this is and `PORTING.md` for what a
port implements/reuses.

## Usage

```yaml
ashurbanipal:
  enabled: ${ASHURBANIPAL_ENABLED:false}
  # Defaults to "postgres"; "mysql" (covers MariaDB too) or "sqlite" opt in
  # to the alternate DbSource implementations below.
  backend: postgres
```

Autoconfigured — no bean wiring needed beyond the host's own `DataSource`.
Backend selection is always an explicit config property, never inferred
from which JDBC driver happens to be on the classpath (`PORTING.md`'s
hardening checklist item 2). This starter has no opinion on which
environment it's running in — deciding when `enabled` is true is entirely
up to the host. Absent config means disabled (no `DbViewerController`/
`DbSource` bean registered), never enabled with defaults.


## Database support

Same per-backend degraded features and mechanisms as the Rust reference
(comments/common-values unavailable on SQLite and MySQL, MySQL-vs-MariaDB
runtime detection for the query-timeout mechanism, Xerial `sqlite-jdbc`'s
`ProgressHandler` instead of JDBC's non-functional `setQueryTimeout`) —
see `docs/adapter-decisions.md` for the full registry. A host opting into
`mysql`/`sqlite` still supplies its own `DataSource` bean; this starter
never adds a JDBC driver dependency of its own.

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).
