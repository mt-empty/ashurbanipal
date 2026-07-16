# Ashurbanipal

A self-contained, embeddable database browser for development and testing environments. It gives developers a web UI to browse their service's database tables without leaving the browser or configuring external tools.

### What it does

- Lists all tables in the database with approximate row counts.
- Displays table data with pagination, sorting, and SQL-like filtering.
- Auto-expands `jsonb` columns into readable nested objects.
- Shows column types such as UUID, timestamp, jsonb, etc. as badges on every column.
- Provides a Monaco Editor side-by-side diff view for comparing `jsonb` values between rows.
- Links to sibling services so you can jump between databases in a multi-service architecture.

### Architecture

Two components:

1. **Frontend** — a static HTML file (`dbviewer.html`) containing the entire frontend in a single file, framework-agnostic. It talks to the backend via four REST endpoints and uses a CDN-loaded Monaco Editor and JSON tree viewer. This file is identical regardless of backend language.

2. **Backend** — a module implementing four endpoints using the service's existing database connection:
   - `GET /api/tables` — list table names.
   - `GET /api/table-counts` — approximate row counts via `pg_class.reltuples`.
   - `GET /api/tables/data?table=x&filter=y&limit=50&offset=0&sort=created_at&order=desc` — paginated, filtered table data.
   - `GET /api/siblings` — list of sibling service names, for cross-service navigation.

### Key properties

- **Embedded** — runs inside the service process, not a separate container or sidecar.
- **No extra credentials** — reuses the service's own database connection.
- **Read-only** — `SELECT` queries only; uses a read replica/data source where available.
- **Single-file frontend** — no build step, no node_modules, no bundler.
- **Guarded by a kill switch** — enabled only in dev/test environments via config.
- **SQL-injection safe** — validates table names against the actual schema, allow-lists filter operators, and parameterizes all values.

### Filter syntax

Users type a SQL-like expression in the search box, e.g.:

```
status = completed AND created_at > 2016-01-01
session_id = 18d852af-77ae-4a95-9f7d-e37a77fda2fd
```

Supported operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `IS NULL`, `IS NOT NULL`. Columns are cast to text for compatibility with UUID and timestamp types.
