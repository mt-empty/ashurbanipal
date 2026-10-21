//! Demo host service embedding Ashurbanipal — the living usage example and
//! integration-test harness.
//!
//! Run against the devcontainer's seeded Postgres:
//!
//! ```sh
//! cargo run -p ashurbanipal-axum --example demo
//! # then open http://localhost:4000/__ashurbanipal
//! ```
//!
//! `-p` disambiguates against the sibling `ashurbanipal-actix-web` crate's
//! own `examples/demo.rs` in the same workspace.
//!
//! To demo sibling health-polling, run a second instance:
//!
//! ```sh
//! PORT=4001 SIBLING_PORT=4000 cargo run -p ashurbanipal-axum --example demo
//! ```
//!
//! To demo multi-source browsing (a second, distinctly-seeded database —
//! `.devcontainer/db/init/02-reporting-seed.sql` — registered as a
//! `reporting` source alongside `primary`):
//!
//! ```sh
//! SECOND_SOURCE=1 cargo run -p ashurbanipal-axum --example demo
//! ```
//!
//! `CONFORMANCE_SECOND_SOURCE=1` registers a second source, pinned to
//! `other_schema`, for `conformance/runner/two_source.rs` — see that
//! file's module doc.
//!
//! `DB_BACKEND` selects the backend: `postgres` (default, from
//! `DATABASE_URL`), `sqlite` (from `SQLITE_PATH`, needs `--features sqlite`),
//! or `mysql` (from `DATABASE_URL`, needs `--features mysql`). The
//! `SECOND_SOURCE` / `CONFORMANCE_SECOND_SOURCE` extras are Postgres-only.

use ashurbanipal_axum::{Config, PgPoolSource};
use axum::routing::get;
use axum::Router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt::init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4000);
    let sibling_port: Option<u16> = std::env::var("SIBLING_PORT")
        .ok()
        .and_then(|p| p.parse().ok());
    let mount_prefix: Option<String> = std::env::var("MOUNT_PREFIX").ok().filter(|p| !p.is_empty());

    let config = Config::from_toml(&format!(
        "enabled = true\n{}",
        siblings_toml(port, sibling_port)
    ))?;

    let db_backend = std::env::var("DB_BACKEND").unwrap_or_else(|_| "postgres".to_string());
    let ashurbanipal = match db_backend.as_str() {
        "postgres" => build_postgres_router(config).await?,
        #[cfg(feature = "sqlite")]
        "sqlite" => {
            use std::str::FromStr;
            let path = std::env::var("SQLITE_PATH")
                .expect("SQLITE_PATH must be set when DB_BACKEND=sqlite");
            let opts = sqlx::sqlite::SqliteConnectOptions::from_str(&path)?.create_if_missing(true);
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(5)
                .connect_with(opts)
                .await?;
            let source = ashurbanipal_axum::SqliteSource::new(pool);
            ashurbanipal_axum::router(config, vec![("primary".to_string(), source)])
        }
        #[cfg(feature = "mysql")]
        "mysql" => {
            let database_url = std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set when DB_BACKEND=mysql");
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(5)
                .connect(&database_url)
                .await?;
            let source = ashurbanipal_axum::MySqlSource::new(pool);
            ashurbanipal_axum::router(config, vec![("primary".to_string(), source)])
        }
        other => {
            return Err(format!(
                "unknown DB_BACKEND {other:?} (or its Cargo feature is not compiled in — \
                 rebuild with `--features sqlite` / `--features mysql`)"
            )
            .into())
        }
    };
    // MOUNT_PREFIX (e.g. "/svc") simulates a reverse proxy that serves the
    // host under a path prefix, to exercise the frontend's mount-point
    // agnosticism; unset means the plain one-line merge as before.
    let ashurbanipal = match &mount_prefix {
        Some(prefix) => Router::new().nest(prefix, ashurbanipal),
        None => ashurbanipal,
    };
    let ui_path = format!("{}/__ashurbanipal", mount_prefix.as_deref().unwrap_or(""));

    // The host app: its own routes, plus the one-line Ashurbanipal merge.
    // The root redirect is demo-only convenience; a real host has its own "/".
    let redirect_to = ui_path.clone();
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/",
            get(move || async move { axum::response::Redirect::temporary(&redirect_to) }),
        )
        .merge(ashurbanipal);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("demo host on http://localhost:{port} — browser at http://localhost:{port}{ui_path}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// The default Postgres path, including the `SECOND_SOURCE` /
/// `CONFORMANCE_SECOND_SOURCE` extras (both Postgres-only).
async fn build_postgres_router(config: Config) -> Result<Router, Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    // SECOND_SOURCE demos the multi-source router end-to-end with real
    // second storage: "reporting" is its own database on the same Postgres
    // server (.devcontainer/db/init/02-reporting-seed.sql), not just a
    // second name for the same pool — so switching sources in the UI shows
    // genuinely different tables/data, not the same rows twice.
    let mut sources = vec![("primary".to_string(), PgPoolSource::new(pool))];
    if std::env::var("SECOND_SOURCE").is_ok() {
        let reporting_url = std::env::var("REPORTING_DATABASE_URL").unwrap_or_else(|_| {
            let (prefix, _) = database_url
                .rsplit_once('/')
                .expect("DATABASE_URL has a /dbname path segment");
            format!("{prefix}/ashurbanipal_reporting")
        });
        let reporting_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&reporting_url)
            .await?;
        sources.push(("reporting".to_string(), PgPoolSource::new(reporting_pool)));
    }
    if std::env::var("CONFORMANCE_SECOND_SOURCE").is_ok() {
        let pinned_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::Executor::execute(conn, "set search_path = other_schema").await?;
                    Ok(())
                })
            })
            .connect(&database_url)
            .await?;
        sources.push(("other_schema".to_string(), PgPoolSource::new(pinned_pool)));
    }
    Ok(ashurbanipal_axum::router(config, sources))
}

/// `SIBLING_LABEL` labels the `SIBLING_PORT` sibling and `INSTANCE_LABEL`
/// names this instance, both as service `demo`, so two demos show a labelled
/// pair; either label also adds three services that are down under both
/// labels, to fill the grid. `CONFORMANCE_LABELLED_SIBLINGS=1` replaces all
/// of it with the fixed config `conformance/runner/labelled_siblings.rs`
/// expects.
fn siblings_toml(port: u16, sibling_port: Option<u16>) -> String {
    if std::env::var("CONFORMANCE_LABELLED_SIBLINGS").is_ok() {
        return CONFORMANCE_LABELLED_SIBLINGS.to_string();
    }
    let label = |var: &str| std::env::var(var).ok().filter(|v| !v.is_empty());
    let entry = |name: &str, label: Option<&str>, base: &str| {
        let label = label
            .map(|l| {
                format!(
                    "label = {l:?}
"
                )
            })
            .unwrap_or_default();
        format!(
            "[[siblings]]
name = {name:?}
{label}base_url = \"{base}/__ashurbanipal\"
health_path = \"/health\"
"
        )
    };
    let mut toml = String::new();
    let own = label("INSTANCE_LABEL");
    if let Some(l) = &own {
        toml += &format!(
            "[instance]
name = \"demo\"
label = {l:?}
"
        );
    }
    // Both demos of a labelled pair build the same list, sorted by label and
    // including their own entry, so both show the same grid.
    let mut demos: Vec<(String, u16)> = own.iter().map(|l| (l.clone(), port)).collect();
    match (sibling_port, label("SIBLING_LABEL")) {
        (Some(p), Some(l)) => demos.push((l, p)),
        (Some(p), None) => {
            toml += &entry(&format!("demo-{p}"), None, &format!("http://localhost:{p}"))
        }
        _ => {}
    }
    demos.sort();
    demos.dedup_by(|a, b| a.0 == b.0);
    for (l, p) in &demos {
        toml += &entry("demo", Some(l), &format!("http://localhost:{p}"));
    }
    // Port 9 refuses at once, so these are a fast `healthy: false`.
    for name in ["search", "analytics", "inventory"] {
        for (l, _) in &demos {
            toml += &entry(name, Some(l), "http://127.0.0.1:9");
        }
    }
    toml
}

// Port 9 refuses at once, so every health check is a fast `healthy: false`.
const CONFORMANCE_LABELLED_SIBLINGS: &str = r#"
[instance]
name = "conformance"
label = "a"

[[siblings]]
name = "conformance"
label = "a"
base_url = "http://127.0.0.1:9/__ashurbanipal"
health_path = "/health"

[[siblings]]
name = "conformance"
label = "b"
base_url = "http://127.0.0.1:9/__ashurbanipal"
health_path = "/health"

[[siblings]]
name = "other"
label = "a"
base_url = "http://127.0.0.1:9/__ashurbanipal"
health_path = "/health"
"#;
