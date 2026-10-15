//! `spec/protocol.md` §5.11 against Postgres catalog types the conformance
//! seed cannot vary: enum identity, arrays, and the timeout label.

use ashurbanipal_axum::{DbError, DbSource, JoinOpts, JoinSpec, PgPoolSource};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

// One schema per test: they run concurrently.
const SCHEMA_TYPES: &str = "ashb_test_join_types";
const SCHEMA_SLOW: &str = "ashb_test_join_slow";

async fn setup(schema: &str, ddl: &str) -> PgPool {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect for setup");
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {schema} cascade; create schema {schema}; {ddl}"
    )))
    .await
    .expect("setup schema");
    pool
}

async fn teardown(pool: &PgPool, schema: &str) {
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {schema} cascade;"
    )))
    .await
    .ok();
}

fn opts(timeout_secs: u32) -> JoinOpts {
    JoinOpts {
        limit: 10,
        offset: 0,
        sort: None,
        sort_join: None,
        descending: false,
        timeout_secs,
        filter: None,
    }
}

fn on(left_table: &str, left_col: &str, right_table: &str, right_col: &str) -> JoinSpec {
    JoinSpec::parse(&format!(
        r#"{{"table":"{left_table}","joins":[{{"type":"inner","table":"{right_table}",
            "on":[{{"left":{{"join":0,"column":"{left_col}"}},"right":"{right_col}"}}]}}]}}"#
    ))
    .unwrap()
}

#[tokio::test]
async fn enums_pair_only_within_one_type_and_arrays_never_join() {
    let s = SCHEMA_TYPES;
    let pool = setup(
        s,
        &format!(
            "create type {s}.mood as enum ('ok', 'sad'); \
             create type {s}.size as enum ('s', 'm'); \
             create table {s}.a (id int primary key, m {s}.mood, z {s}.size, tags text[], n numeric); \
             create table {s}.b (id int primary key, m {s}.mood, z {s}.size, tags text[], n bigint); \
             insert into {s}.a values (1, 'ok', 's', '{{x}}', 1.0); \
             insert into {s}.b values (1, 'ok', 's', '{{x}}', 1);"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());

    let same = source
        .query_join(Some(s), &on("a", "m", "b", "m"), opts(5))
        .await
        .unwrap();
    assert_eq!(same.rows.len(), 1);

    assert!(matches!(
        source
            .query_join(Some(s), &on("a", "m", "b", "z"), opts(5))
            .await,
        Err(DbError::BadJoin(_))
    ));
    assert!(matches!(
        source
            .query_join(Some(s), &on("a", "tags", "b", "tags"), opts(5))
            .await,
        Err(DbError::BadJoin(_))
    ));
    // numeric and bigint are one class.
    let mixed = source
        .query_join(Some(s), &on("a", "n", "b", "n"), opts(5))
        .await
        .unwrap();
    assert_eq!(mixed.rows.len(), 1);

    teardown(&pool, s).await;
}

#[tokio::test]
async fn a_slow_join_is_a_query_timeout_and_releases_the_connection() {
    let s = SCHEMA_SLOW;
    let pool = setup(
        s,
        &format!(
            "create table {s}.a as select g as id, g % 2 as k from generate_series(1, 20000) g; \
             create table {s}.b as select g as id, g % 2 as k from generate_series(1, 20000) g;"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());

    // 200M matching pairs, and the sort forces them all to be produced.
    let mut slow = opts(1);
    slow.sort = Some("id".into());
    slow.descending = true;
    let started = std::time::Instant::now();
    let result = source
        .query_join(Some(s), &on("a", "k", "b", "k"), slow)
        .await;
    assert!(
        matches!(result, Err(DbError::QueryTimeout)),
        "expected QueryTimeout, got {result:?}"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));

    let ok = source
        .query_join(Some(s), &on("a", "id", "b", "id"), opts(5))
        .await
        .unwrap();
    assert_eq!(ok.rows.len(), 10);
    assert!(ok.has_more);

    teardown(&pool, s).await;
}
