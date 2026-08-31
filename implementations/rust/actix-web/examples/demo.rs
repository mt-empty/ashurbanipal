//! Demo host service embedding the Actix-web adapter.
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
//!
//! `CONFORMANCE_SECOND_SOURCE=1` registers a second source, pinned to
//! `other_schema`, for `conformance/runner/two_source.rs` — see that
//! file's module doc.

use actix_web::{web, App, HttpResponse, HttpServer};
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};

#[actix_web::main]
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
                base_url = "http://localhost:{p}/__ashurbanipal"
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

    let mut sources = vec![("primary".to_string(), PgPoolSource::new(pool))];
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
    let state = app_state(config, sources);
    let ui_path = format!("{}/__ashurbanipal", mount_prefix.as_deref().unwrap_or(""));

    println!("demo host on http://localhost:{port} — browser at http://localhost:{port}{ui_path}");
    // The root redirect and /health are demo-only convenience; a real host
    // has its own "/" and health check.
    let redirect_to = ui_path.clone();
    HttpServer::new(move || {
        let ashurbanipal = service(state.clone());
        let app = App::new()
            .route("/health", web::get().to(|| async { "ok" }))
            .route(
                "/",
                web::get().to({
                    let redirect_to = redirect_to.clone();
                    move || {
                        let redirect_to = redirect_to.clone();
                        async move {
                            HttpResponse::TemporaryRedirect()
                                .insert_header(("Location", redirect_to))
                                .finish()
                        }
                    }
                }),
            );
        // MOUNT_PREFIX (e.g. "/svc") simulates a reverse proxy that serves
        // the host under a path prefix, to exercise the frontend's
        // mount-point agnosticism; unset means the plain direct mount.
        match &mount_prefix {
            Some(prefix) => app.service(web::scope(prefix).service(ashurbanipal)),
            None => app.service(ashurbanipal),
        }
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await?;
    Ok(())
}
