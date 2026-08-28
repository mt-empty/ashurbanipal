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

```sh
cargo add ashurbanipal --features mysql   # or --features sqlite
```

Drop Postgres entirely with `--no-default-features`:

```sh
cargo add ashurbanipal --no-default-features --features sqlite   # or --features mysql
```

Most hosts only need one backend — if that's not Postgres, dropping it
is recommended.

See either framework adapter's README for a working usage example, or
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md)
for the full API/config reference.
