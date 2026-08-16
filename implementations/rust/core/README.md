# ashurbanipal

Framework-agnostic core (config, `DbSource` backends, filter DSL) behind
[`ashurbanipal-axum`](../axum/README.md) and
[`ashurbanipal-actix-web`](../actix-web/README.md) — most hosts should
depend on one of those adapters instead of this crate directly, unless
you're building a new framework adapter.

```sh
cargo add ashurbanipal
```

## Database support

Postgres by default (the `postgres` feature); MySQL/MariaDB and SQLite
behind the `mysql`/`sqlite` features:

```toml
[dependencies]
ashurbanipal = { version = "0.2", features = ["mysql"] } # or "sqlite"
```

Drop Postgres entirely with `default-features = false`:

```toml
[dependencies]
ashurbanipal = { version = "0.2", default-features = false, features = ["sqlite"] } # or "mysql"
```

See either framework adapter's README for a working usage example, or
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md)
for the full API/config reference.
