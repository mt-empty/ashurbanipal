//! One router holding sources of two different backends (SQLite and MySQL),
//! each reachable through the `source` param (spec/protocol.md §1, §5.8).
//!
//! Needs `--features sqlite,mysql` and `MYSQL_TEST_URL` (mise:
//! `rust:integration-test-mysql`). The SQLite side is an in-memory database
//! on a single-connection pool, as in `multi_source_sqlite.rs`.

use ashurbanipal_axum::{router, Config, MySqlSource, Source, SqliteSource};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::Executor;
use tower::ServiceExt;

mod common;
use common::MysqlCleanup;

const MYSQL_DB: &str = "ashb_test_mixed_backends";

async fn sqlite_source() -> SqliteSource {
    // max_connections(1): each `sqlite::memory:` connection is its own database.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("open in-memory sqlite");
    pool.execute("create table probe_sqlite (id integer primary key, marker text not null)")
        .await
        .unwrap();
    pool.execute("insert into probe_sqlite values (1, 'SQLITE')")
        .await
        .unwrap();
    SqliteSource::new(pool)
}

async fn mysql_source(test_url: &str) -> MySqlSource {
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(test_url)
        .await
        .expect("connect to MYSQL_TEST_URL");
    for stmt in [
        format!("drop database if exists {MYSQL_DB}"),
        format!("create database {MYSQL_DB}"),
        format!("create table {MYSQL_DB}.probe_mysql (id int primary key, marker varchar(50))"),
        format!("insert into {MYSQL_DB}.probe_mysql values (1, 'MYSQL')"),
    ] {
        pool.execute(sqlx::AssertSqlSafe(stmt)).await.unwrap();
    }
    MySqlSource::new(pool)
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
async fn one_router_serves_a_sqlite_and_a_mysql_source() {
    let test_url = std::env::var("MYSQL_TEST_URL")
        .expect("MYSQL_TEST_URL must be set (the devcontainer sets it automatically)");
    let mysql = mysql_source(&test_url).await;
    let _cleanup = MysqlCleanup {
        url: test_url.clone(),
        statements: vec![format!("drop database if exists {MYSQL_DB}")],
    };

    let config = Config::from_toml("enabled = true").unwrap();
    let app = router(
        config,
        vec![
            ("local".to_string(), Source::new(sqlite_source().await)),
            ("remote".to_string(), Source::new(mysql)),
        ],
    );

    assert_eq!(
        get_json(&app, "/__ashurbanipal/api/sources").await,
        serde_json::json!({
            "sources": [{"name": "local", "engine": "sqlite"}, {"name": "remote", "engine": "mysql"}],
            "default": "local"
        })
    );

    assert_eq!(
        get_json(&app, "/__ashurbanipal/api/tables").await,
        serde_json::json!({"tables": [{"name": "probe_sqlite"}]})
    );
    let local_rows = get_json(&app, "/__ashurbanipal/api/tables/data?table=probe_sqlite").await;
    assert_eq!(local_rows["rows"][0]["marker"], serde_json::json!("SQLITE"));

    assert_eq!(
        get_json(
            &app,
            &format!("/__ashurbanipal/api/tables?source=remote&schema={MYSQL_DB}"),
        )
        .await,
        serde_json::json!({"tables": [{"name": "probe_mysql"}]})
    );
    let remote_rows = get_json(
        &app,
        &format!(
            "/__ashurbanipal/api/tables/data?source=remote&schema={MYSQL_DB}&table=probe_mysql"
        ),
    )
    .await;
    assert_eq!(remote_rows["rows"][0]["marker"], serde_json::json!("MYSQL"));
}
