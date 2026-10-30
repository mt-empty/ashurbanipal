# Ashurbanipal Spring Boot starter

Kotlin/Spring Boot autoconfiguration starter implementing `spec/protocol.md`
— see the repo root `readme.md` for what this is and `PORTING.md` for what a
port implements/reuses.

## Usage

```yaml
ashurbanipal:
  enabled: ${ASHURBANIPAL_ENABLED:false}

  # Optional. Omit entirely for a single-datasource host: it's equivalent
  # to `sources: [{name: default, backend: postgres}]`, bound to the
  # primary/only DataSource bean in the context.
  sources:
    - name: primary
      backend: postgres # or "mysql" (covers MariaDB too), "sqlite"
      # data-source-bean: ordersDataSourceV2  # only needed with >1 DataSource bean

  # optional — these are the defaults/examples, shown explicitly
  base-path: /__ashurbanipal
  limits:
    default-page-size: 50
    max-page-size: 100
    query-timeout-secs: 5
  instance: # this instance's own name and label (spec/protocol.md §5.6)
    name: orders
    label: dev
  # One shared list, in the same order, on every instance keeps the grid the same everywhere.
  siblings:
    - name: orders
      label: int # optional; typically an environment (dev, int) or a region (eu, us)
      base-url: https://orders-int.internal.vpn/__ashurbanipal
      health-path: /health
    - name: billing
      base-url: https://billing.internal.vpn/__ashurbanipal
      health-path: /health
```

Autoconfigured — no bean wiring needed beyond the host's own `DataSource`
bean(s). Each `sources` entry gets its own `DbSource`, selectable via the
`source` query param (`spec/protocol.md` §1, §5.8); the first entry is the
default used when `source` is absent. `data-source-bean` picks which
`DataSource` bean an entry binds to — required once the context has more
than one, since there's no default to fall back on. Backend selection is
always an explicit config property, never inferred from which JDBC driver
happens to be on the classpath (`PORTING.md`'s hardening checklist item
2). This starter has no opinion on which environment it's running in —
deciding when `enabled` is true is entirely up to the host. Absent config
means disabled (no `AshurbanipalController`/`DbSource` bean registered),
never enabled with defaults.


## Integration requirements

Two host-side settings this starter deliberately does not apply for you,
since both would change host-global behavior (`PORTING.md`):

- **Strict CSP** — the vendored `dbviewer.html` runs an inline
  `<script type="module">`. A host whose `Content-Security-Policy` forbids
  inline scripts must extend `script-src` for `${ashurbanipal.base-path}`
  or the UI renders but never loads data. This starter sets no CSP header
  of its own (`PORTING.md`, "CSP and inline scripts").
- **Large filters** — a `filter` query param near `spec/protocol.md`
  §5.4.2's 8192-byte cap can overrun embedded Tomcat's default 8 KiB
  `server.max-http-request-header-size` once URL-encoded, yielding
  Tomcat's own 400 page instead of the protocol's. Raise
  `server.max-http-request-header-size` (e.g. `64KB`) if your users build
  filters that large (`PORTING.md`, "Request-boundary rejections").

## Compression

The UI page is sent gzipped when the browser accepts gzip (`spec/protocol.md` §5.1); it is compressed once, at start-up. API responses are sent uncompressed. A host that sets `server.compression.enabled=true` compresses them too; Tomcat leaves the page alone, because it already carries `Content-Encoding`.

## Behind your own auth

Ashurbanipal ships no authentication ([`docs/design.md`](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md) §6); guard the mount prefix with your host's own. Cover the whole prefix, UI included, and check a role rather than just a login — otherwise every signed-in user can read every table the database role can. With Spring Security, add a rule for the starter's path:

```kotlin
http.authorizeHttpRequests {
    it.requestMatchers("/__ashurbanipal/**").hasRole("ADMIN")
}
```

Use `${ashurbanipal.base-path}` in place of `/__ashurbanipal` if you changed it. Without Spring Security, a `OncePerRequestFilter` that matches only that prefix does the same job.

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
