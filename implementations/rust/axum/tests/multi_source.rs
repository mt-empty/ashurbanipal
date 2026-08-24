//! Router-level coverage for multi-source dispatch (spec/protocol.md §1,
//! §5.8). `resolve_source` itself is unit-tested in `ashurbanipal-core`, and
//! `conformance/runner/sources.rs` only ever registers one source (see its
//! "Known gaps" note in `COVERAGE.md`) — this file is the only place two
//! real sources actually get routed through the live axum `Router`, proving
//! the wiring, not just the resolution logic in isolation.
//!
//! Each "source" is a distinct connection pool pinned (via `after_connect`)
//! to its own schema, the same stand-in-for-a-second-database trick
//! `schema_isolation.rs` uses — a real second Postgres instance isn't
//! available in this environment (PORTING.md).

use ashurbanipal_axum::{router, Config, PgPoolSource};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use sqlx::postgres::PgPoolOptions;
use sqlx::Executor;
use tower::ServiceExt;

const SOURCE_SCHEMA_ALPHA: &str = "ashb_test_multi_source_alpha";
const SOURCE_SCHEMA_BETA: &str = "ashb_test_multi_source_beta";

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

async fn get_status(app: &axum::Router, path: &str) -> StatusCode {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    response.status()
}

async fn get_json(app: &axum::Router, path: &str) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "GET {path}");
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn omitting_source_resolves_to_first_registered_and_explicit_source_reaches_its_own_data() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    let alpha = build_pinned_source(&database_url, SOURCE_SCHEMA_ALPHA, "ALPHA").await;
    let beta = build_pinned_source(&database_url, SOURCE_SCHEMA_BETA, "BETA").await;
    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(
        config,
        vec![("alpha".to_string(), alpha), ("beta".to_string(), beta)],
    );

    let default_data = get_json(
        &app,
        "/__ashurbanipal/api/tables/data?table=probe_multi_source",
    )
    .await;
    let alpha_data = get_json(
        &app,
        "/__ashurbanipal/api/tables/data?table=probe_multi_source&source=alpha",
    )
    .await;
    let beta_data = get_json(
        &app,
        "/__ashurbanipal/api/tables/data?table=probe_multi_source&source=beta",
    )
    .await;

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

#[tokio::test]
async fn unknown_source_is_rejected_with_400_on_every_source_aware_route() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    // resolve_source rejects the unknown name before any table/column is
    // ever touched, so a single plain pool (no schema fixture) is enough.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect source pool");
    let source = PgPoolSource::new(pool);
    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(config, vec![("alpha".to_string(), source)]);

    for path in [
        "/__ashurbanipal/api/schemas?source=nonexistent",
        "/__ashurbanipal/api/tables?source=nonexistent",
        "/__ashurbanipal/api/table-counts?source=nonexistent",
        "/__ashurbanipal/api/tables/data?source=nonexistent&table=whatever",
        "/__ashurbanipal/api/tables/common-values?source=nonexistent&table=whatever&column=id",
    ] {
        assert_eq!(
            get_status(&app, path).await,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}

#[tokio::test]
async fn api_sources_lists_registered_names_in_registration_order_with_no_backend_field() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect source pool");
    let config = Config::from_toml("enabled = true").unwrap();
    // Registered "second" before "first" — proves /api/sources preserves
    // registration order rather than sorting alphabetically.
    let app = router(
        config,
        vec![
            ("second".to_string(), PgPoolSource::new(pool.clone())),
            ("first".to_string(), PgPoolSource::new(pool)),
        ],
    );

    let body = get_json(&app, "/__ashurbanipal/api/sources").await;
    assert_eq!(
        body,
        serde_json::json!({"sources": [{"name": "second"}, {"name": "first"}]})
    );
}
