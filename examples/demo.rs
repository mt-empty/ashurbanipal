//! Demo host service embedding Ashurbanipal — the living usage example and
//! integration-test harness.
//!
//! Run against the devcontainer's seeded Postgres:
//!
//! ```sh
//! cargo run --example demo
//! # then open http://localhost:4000/__ashurbanipal
//! ```
//!
//! To demo sibling health-polling, run a second instance:
//!
//! ```sh
//! PORT=4001 SIBLING_PORT=4000 cargo run --example demo
//! ```

use ashurbanipal::{Config, PgPoolSource};
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
        environment = "dev"
        enabled_for = ["dev"]
        {siblings_toml}
        "#
    ))?;

    // The host app: its own routes, plus the one-line Ashurbanipal merge.
    // The root redirect is demo-only convenience; a real host has its own "/".
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/__ashurbanipal") }),
        )
        .merge(ashurbanipal::router(config, PgPoolSource::new(pool)));

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!(
        "demo host on http://localhost:{port} — browser at http://localhost:{port}/__ashurbanipal"
    );
    axum::serve(listener, app).await?;
    Ok(())
}
