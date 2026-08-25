//! Router-level coverage for multi-source dispatch (spec/protocol.md §1,
//! §5.8) — the Actix-web analog of `ashurbanipal-axum`'s own
//! `tests/multi_source.rs`. `resolve_source` itself is unit-tested in
//! `ashurbanipal-core`; this file is what actually drives two real sources
//! through the live Actix `service()`, proving the wiring (not just the
//! resolution logic) for this adapter specifically — `actix_web::test`'s
//! in-process harness has no equivalent to axum's `tower::ServiceExt::oneshot`,
//! so it can't be shared verbatim between the two adapters.
//!
//! Each "source" is a distinct connection pool pinned (via `after_connect`)
//! to its own schema, the same stand-in-for-a-second-database trick
//! `schema_isolation.rs` (and axum's `multi_source.rs`) use — a real second
//! Postgres instance isn't available in this environment (PORTING.md).

use actix_web::test::{call_service, init_service, read_body_json, TestRequest};
use actix_web::App;
use ashurbanipal_actix_web::{app_state, service, Config, PgPoolSource};
use sqlx::postgres::PgPoolOptions;
use sqlx::Executor;

const SOURCE_SCHEMA_ALPHA: &str = "ashb_test_actix_multi_source_alpha";
const SOURCE_SCHEMA_BETA: &str = "ashb_test_actix_multi_source_beta";

async fn build_pinned_source(
    database_url: &str,
    schema: &'static str,
    marker: &str,
) -> PgPoolSource {
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for schema setup");
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "drop schema if exists {schema} cascade"
        )))
        .await
        .unwrap();
    admin
        .execute(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .await
        .unwrap();
    admin
        .execute(sqlx::AssertSqlSafe(format!(
            "create table {schema}.probe_multi_source (id int primary key, marker text); \
             insert into {schema}.probe_multi_source values (1, '{marker}'), (2, '{marker}');"
        )))
        .await
        .unwrap();

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |conn, _meta| {
            Box::pin(async move {
                conn.execute(sqlx::AssertSqlSafe(format!("set search_path = {schema}")))
                    .await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await
        .expect("connect pinned source pool");
    PgPoolSource::new(pool)
}

async fn connect_plain_pool(database_url: &str) -> sqlx::PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect source pool")
}

async fn teardown_schemas(database_url: &str, schemas: &[&str]) {
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for schema teardown");
    for schema in schemas {
        admin
            .execute(sqlx::AssertSqlSafe(format!(
                "drop schema if exists {schema} cascade"
            )))
            .await
            .ok();
    }
}

#[actix_web::test]
async fn omitting_source_resolves_to_first_registered_and_explicit_source_reaches_its_own_data() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    let (alpha, beta) = tokio::join!(
        build_pinned_source(&database_url, SOURCE_SCHEMA_ALPHA, "ALPHA"),
        build_pinned_source(&database_url, SOURCE_SCHEMA_BETA, "BETA"),
    );
    let config = Config::from_toml("enabled = true").unwrap();
    let state = app_state(
        config,
        vec![("alpha".to_string(), alpha), ("beta".to_string(), beta)],
    );
    let app = init_service(App::new().service(service(state))).await;

    const BASE: &str = "/__ashurbanipal/api/tables/data?table=probe_multi_source";
    let (default_data, alpha_data, beta_data): (
        serde_json::Value,
        serde_json::Value,
        serde_json::Value,
    ) = tokio::join!(
        async {
            read_body_json(call_service(&app, TestRequest::get().uri(BASE).to_request()).await)
                .await
        },
        async {
            read_body_json(
                call_service(
                    &app,
                    TestRequest::get()
                        .uri(&format!("{BASE}&source=alpha"))
                        .to_request(),
                )
                .await,
            )
            .await
        },
        async {
            read_body_json(
                call_service(
                    &app,
                    TestRequest::get()
                        .uri(&format!("{BASE}&source=beta"))
                        .to_request(),
                )
                .await,
            )
            .await
        },
    );

    assert_eq!(
        default_data, alpha_data,
        "an absent source param must resolve to the first-registered source"
    );
    assert_ne!(
        alpha_data, beta_data,
        "an explicit source param must actually reach that source's own data, not just be accepted"
    );

    teardown_schemas(&database_url, &[SOURCE_SCHEMA_ALPHA, SOURCE_SCHEMA_BETA]).await;
}

#[actix_web::test]
async fn unknown_source_is_rejected_with_400_on_every_source_aware_route() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    // resolve_source rejects the unknown name before any table/column is
    // ever touched, so a single plain pool (no schema fixture) is enough.
    let pool = connect_plain_pool(&database_url).await;
    let config = Config::from_toml("enabled = true").unwrap();
    let state = app_state(config, vec![("alpha".to_string(), PgPoolSource::new(pool))]);
    let app = init_service(App::new().service(service(state))).await;

    for path in [
        "/__ashurbanipal/api/schemas?source=nonexistent",
        "/__ashurbanipal/api/tables?source=nonexistent",
        "/__ashurbanipal/api/table-counts?source=nonexistent",
        "/__ashurbanipal/api/tables/data?source=nonexistent&table=whatever",
        "/__ashurbanipal/api/tables/common-values?source=nonexistent&table=whatever&column=id",
    ] {
        let resp = call_service(&app, TestRequest::get().uri(path).to_request()).await;
        assert_eq!(resp.status(), 400, "{path}");
    }
}

#[actix_web::test]
async fn api_sources_lists_registered_names_in_registration_order_with_no_backend_field() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = connect_plain_pool(&database_url).await;
    let config = Config::from_toml("enabled = true").unwrap();
    // Registered "second" before "first" — proves /api/sources preserves
    // registration order rather than sorting alphabetically.
    let state = app_state(
        config,
        vec![
            ("second".to_string(), PgPoolSource::new(pool.clone())),
            ("first".to_string(), PgPoolSource::new(pool)),
        ],
    );
    let app = init_service(App::new().service(service(state))).await;

    let body: serde_json::Value = read_body_json(
        call_service(
            &app,
            TestRequest::get()
                .uri("/__ashurbanipal/api/sources")
                .to_request(),
        )
        .await,
    )
    .await;
    assert_eq!(
        body,
        serde_json::json!({"sources": [{"name": "second"}, {"name": "first"}]})
    );
}
