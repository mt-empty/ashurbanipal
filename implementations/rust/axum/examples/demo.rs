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

    let ashurbanipal = ashurbanipal_axum::router(config, PgPoolSource::new(pool));
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
