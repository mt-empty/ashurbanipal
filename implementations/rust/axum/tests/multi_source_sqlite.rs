//! Router-level coverage for the SQLite backend (spec/protocol.md §1, §5.8),
//! the analog of `multi_source.rs` for Postgres. SQLite has no schema
//! concept and no privilege model, so `schema_isolation.rs` /
//! `table_listing_privileges.rs` have no SQLite counterpart — this file is
//! the only place a `SqliteSource` is routed through the live axum `Router`,
//! proving the wiring end to end, not just the per-method behavior the
//! `core` unit tests already cover.
//!
//! Needs the `mysql`-style opt-in: run via `cargo test --features sqlite
//! --test multi_source_sqlite` (mise: `rust:integration-test-sqlite`). No
//! external service — each source is its own in-memory database on a
//! single-connection pool, the same trick `core/src/db/sqlite.rs`'s tests use.

use ashurbanipal_axum::{router, Config, SqliteSource};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tower::ServiceExt;

async fn seeded_source(marker: &str) -> SqliteSource {
    // max_connections(1): `sqlite::memory:` gives each connection its own
    // database, so a wider pool would see an empty schema on the 2nd
    // connection. One pinned connection keeps the single in-memory db alive.
    let pool: SqlitePool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("open in-memory sqlite");
    sqlx::query(sqlx::AssertSqlSafe(
        "create table probe (id integer primary key, marker text not null);".to_string(),
    ))
    .execute(&pool)
    .await
    .unwrap();
    for id in 1..=2 {
        sqlx::query(sqlx::AssertSqlSafe(
            "insert into probe (id, marker) values (?, ?)".to_string(),
        ))
        .bind(id)
        .bind(marker)
        .execute(&pool)
        .await
        .unwrap();
    }
    SqliteSource::new(pool)
}

async fn get_status(app: &axum::Router, path: &str) -> StatusCode {
    app.clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
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
async fn sqlite_source_round_trips_tables_data_and_schemas_through_the_router() {
    let source = seeded_source("SOLO").await;
    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(config, vec![("primary".to_string(), source)]);

    let tables = get_json(&app, "/__ashurbanipal/api/tables").await;
    let names: Vec<&str> = tables["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["probe"], "only the seeded table is listed");

    let schemas = get_json(&app, "/__ashurbanipal/api/schemas").await;
    assert_eq!(
        schemas["schemas"],
        serde_json::json!(["main"]),
        "sqlite exposes exactly one schema"
    );

    let data = get_json(&app, "/__ashurbanipal/api/tables/data?table=probe").await;
    assert_eq!(data["rows"].as_array().unwrap().len(), 2);
    // Every cell is rendered as a JSON string or null (spec/protocol.md §5.4.4).
    assert_eq!(data["rows"][0]["marker"], serde_json::json!("SOLO"));
}

#[tokio::test]
async fn omitting_source_resolves_to_first_registered_and_explicit_source_reaches_its_own_data() {
    let alpha = seeded_source("ALPHA").await;
    let beta = seeded_source("BETA").await;
    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(
        config,
        vec![("alpha".to_string(), alpha), ("beta".to_string(), beta)],
    );

    let default_data = get_json(&app, "/__ashurbanipal/api/tables/data?table=probe").await;
    let alpha_data = get_json(
        &app,
        "/__ashurbanipal/api/tables/data?table=probe&source=alpha",
    )
    .await;
    let beta_data = get_json(
        &app,
        "/__ashurbanipal/api/tables/data?table=probe&source=beta",
    )
    .await;

    assert_eq!(
        default_data, alpha_data,
        "an absent source param must resolve to the first-registered source"
    );
    assert_ne!(
        alpha_data, beta_data,
        "an explicit source param must actually reach that source's own data"
    );
}

#[tokio::test]
async fn unknown_source_is_rejected_with_400() {
    let source = seeded_source("SOLO").await;
    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(config, vec![("primary".to_string(), source)]);

    for path in [
        "/__ashurbanipal/api/schemas?source=nonexistent",
        "/__ashurbanipal/api/tables?source=nonexistent",
        "/__ashurbanipal/api/table-counts?source=nonexistent",
        "/__ashurbanipal/api/tables/data?source=nonexistent&table=probe",
    ] {
        assert_eq!(
            get_status(&app, path).await,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}
