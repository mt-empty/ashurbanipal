# ashurbanipal

The shared core behind [Ashurbanipal](https://github.com/mt-empty/ashurbanipal)'s Rust adapters. It holds the config, the database backends, and the filter parser.

**You probably want an adapter instead:**

- [`ashurbanipal-axum`](https://crates.io/crates/ashurbanipal-axum) for axum
- [`ashurbanipal-actix-web`](https://crates.io/crates/ashurbanipal-actix-web) for Actix Web

Each adapter re-exports everything from this crate that you need. Depend on this crate directly only to write an adapter for another framework.

## Features

| Feature    | Default | Backend           |
|------------|---------|-------------------|
| `postgres` | on      | Postgres          |
| `mysql`    | off     | MySQL and MariaDB |
| `sqlite`   | off     | SQLite            |

```sh
cargo add ashurbanipal --no-default-features --features sqlite
```
