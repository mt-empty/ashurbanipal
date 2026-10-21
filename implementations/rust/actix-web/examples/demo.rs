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

    let config = Config::from_toml(&format!(
        "enabled = true\n{}",
        siblings_toml(port, sibling_port)
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
