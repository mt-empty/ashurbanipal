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

use ashurbanipal_axum::{Config, PgPoolSource};
use axum::routing::get;
use axum::Router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4000);
    let sibling_port: Option<u16> = std::env::var("SIBLING_PORT")
        .ok()
        .and_then(|p| p.parse().ok());
    let mount_prefix: Option<String> = std::env::var("MOUNT_PREFIX").ok().filter(|p| !p.is_empty());

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    let siblings_toml = sibling_port
        .map(|p| {
            format!(
                r#"
                [[siblings]]
                name = "demo-{p}"
                dbviewer_url = "http://localhost:{p}/__ashurbanipal"
                health_path = "/health"
                "#
            )
        })
        .unwrap_or_default();
    let config = Config::from_toml(&format!(
        r#"
        enabled = true
        {siblings_toml}
        "#
    ))?;

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
    let ashurbanipal = ashurbanipal_axum::router(config, sources);
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
