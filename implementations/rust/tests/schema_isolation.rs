//! Regression test for the "connection pool sessions with different
//! `search_path` settings must not let a request's schema resolution
//! drift mid-flight" guarantee (spec/protocol.md §1, §5).
//!
//! Sets up a pool with two physical connections pinned (via
//! `after_connect`) to two different schemas that each contain a
//! same-named `probe_isolation` table with a *different* column shape.
//! `query_table` validates columns against `information_schema` and then
//! selects those columns from the table — if those two steps could ever
//! land on different connections, the response would either mix
//! shapes/values from both schemas or fail outright with a "column does
//! not exist" error. Running many concurrent calls against the 2-connection
//! pool defeats the pool's LIFO idle-connection reuse (which would
//! otherwise hand a single sequential caller the same connection every
//! time), so a regression to per-step transactions is likely to be caught.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ashurbanipal::{DbSource, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

const SCHEMA_A: &str = "ashb_test_schema_isolation_a";
const SCHEMA_B: &str = "ashb_test_schema_isolation_b";

async fn setup_schemas(database_url: &str) {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for schema setup");

    for schema in [SCHEMA_A, SCHEMA_B] {
        pool.execute(sqlx::AssertSqlSafe(format!(
            "drop schema if exists {schema} cascade"
        )))
        .await
        .unwrap();
        pool.execute(sqlx::AssertSqlSafe(format!("create schema {schema}")))
            .await
            .unwrap();
    }

    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {SCHEMA_A}.probe_isolation (id int primary key, marker text); \
         insert into {SCHEMA_A}.probe_isolation values (1, 'A'), (2, 'A');"
    )))
    .await
    .unwrap();

    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {SCHEMA_B}.probe_isolation (id int primary key, marker text, extra text); \
         insert into {SCHEMA_B}.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X');"
    )))
    .await
    .unwrap();
}

async fn teardown_schemas(pool: &PgPool) {
    for schema in [SCHEMA_A, SCHEMA_B] {
        pool.execute(sqlx::AssertSqlSafe(format!(
            "drop schema if exists {schema} cascade"
        )))
        .await
        .ok();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn query_table_never_mixes_schemas_across_pooled_connections() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    setup_schemas(&database_url).await;

    // Alternates each newly-opened physical connection's search_path
    // between the two schemas, simulating a host pool whose sessions
    // don't all agree on which schema "current_schema()" resolves to.
    let connection_count = Arc::new(AtomicUsize::new(0));
    let pool = PgPoolOptions::new()
        .min_connections(2)
        .max_connections(2)
        .after_connect(move |conn, _meta| {
            let connection_count = connection_count.clone();
            Box::pin(async move {
                let n = connection_count.fetch_add(1, Ordering::SeqCst);
                let schema = if n % 2 == 0 { SCHEMA_A } else { SCHEMA_B };
                conn.execute(sqlx::AssertSqlSafe(format!("set search_path = {schema}")))
                    .await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await
        .expect("connect pool under test");

    // Force both physical connections to actually be established before
    // the concurrent calls below, so both schemas are represented in the
    // pool's idle set.
    let (c1, c2) = tokio::join!(pool.acquire(), pool.acquire());
    drop(c1.unwrap());
    drop(c2.unwrap());

    let source = PgPoolSource::new(pool.clone());

    let opts = || QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };

    let mut handles = Vec::new();
    for _ in 0..40 {
        let source = source.clone();
        handles.push(tokio::spawn(async move {
            source.query_table("probe_isolation", opts()).await
        }));
    }

    for handle in handles {
        let data = handle
            .await
            .expect("task panicked")
            .expect("query_table must not error from a mid-request schema drift");

        let column_names: Vec<&str> = data.columns.iter().map(|c| c.name.as_str()).collect();
        match column_names.as_slice() {
            ["id", "marker"] => {
                for row in &data.rows {
                    assert_eq!(
                        row.get("marker").and_then(|v| v.as_str()),
                        Some("A"),
                        "schema_a shape must only ever contain schema_a's rows"
                    );
                }
            }
            ["id", "marker", "extra"] => {
                for row in &data.rows {
                    assert_eq!(
                        row.get("marker").and_then(|v| v.as_str()),
                        Some("B"),
                        "schema_b shape must only ever contain schema_b's rows"
                    );
                    assert_eq!(row.get("extra").and_then(|v| v.as_str()), Some("X"));
                }
            }
            other => panic!(
                "response mixed columns from both schemas — mid-request schema drift: {other:?}"
            ),
        }
    }

    teardown_schemas(&pool).await;
}
