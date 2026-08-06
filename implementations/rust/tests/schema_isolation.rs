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
// A disjoint pair for the explicit-selection test below — cargo runs tests
// in the same binary concurrently by default, so sharing SCHEMA_A/SCHEMA_B
// with the drift test races on `create schema`.
const SCHEMA_C: &str = "ashb_test_schema_isolation_c";
const SCHEMA_D: &str = "ashb_test_schema_isolation_d";
// Own pair for the cross-schema FK test below, same reasoning as C/D.
const SCHEMA_E: &str = "ashb_test_schema_isolation_e";
const SCHEMA_F: &str = "ashb_test_schema_isolation_f";

async fn setup_schemas(database_url: &str, schema_a: &str, schema_b: &str) {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for schema setup");

    for schema in [schema_a, schema_b] {
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
        "create table {schema_a}.probe_isolation (id int primary key, marker text); \
         insert into {schema_a}.probe_isolation values (1, 'A'), (2, 'A');"
    )))
    .await
    .unwrap();

    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {schema_b}.probe_isolation (id int primary key, marker text, extra text); \
         insert into {schema_b}.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X');"
    )))
    .await
    .unwrap();
}

async fn teardown_schemas(pool: &PgPool, schema_a: &str, schema_b: &str) {
    for schema in [schema_a, schema_b] {
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

    setup_schemas(&database_url, SCHEMA_A, SCHEMA_B).await;

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
            source.query_table(None, "probe_isolation", opts()).await
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

    teardown_schemas(&pool, SCHEMA_A, SCHEMA_B).await;
}

#[tokio::test]
async fn explicit_schema_selects_that_schema_and_rejects_unknown_ones() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    setup_schemas(&database_url, SCHEMA_C, SCHEMA_D).await;

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect pool under test");
    let source = PgPoolSource::new(pool.clone());

    let opts = || QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };

    let data_a = source
        .query_table(Some(SCHEMA_C), "probe_isolation", opts())
        .await
        .expect("schema_c is on the allow-list");
    let columns_a: Vec<&str> = data_a.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        columns_a,
        vec!["id", "marker"],
        "explicit schema_c must see schema_c's shape, not schema_d's"
    );

    let data_b = source
        .query_table(Some(SCHEMA_D), "probe_isolation", opts())
        .await
        .expect("schema_d is on the allow-list");
    let columns_b: Vec<&str> = data_b.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(columns_b, vec!["id", "marker", "extra"]);

    let rejected = source
        .query_table(
            Some("ashb_test_schema_does_not_exist"),
            "probe_isolation",
            opts(),
        )
        .await;
    assert!(
        matches!(rejected, Err(ashurbanipal::DbError::NotAllowed(_))),
        "an unknown schema must be rejected before touching SQL text, not passed through"
    );

    let schemas = source.list_schemas().await.unwrap();
    assert!(schemas.contains(&SCHEMA_C.to_string()));
    assert!(schemas.contains(&SCHEMA_D.to_string()));
    assert!(
        !schemas
            .iter()
            .any(|s| s.starts_with("pg_") || s == "information_schema"),
        "system schemas must never be offered as selectable"
    );

    teardown_schemas(&pool, SCHEMA_C, SCHEMA_D).await;
}

/// Regression test for the cross-schema FK metadata bug: `key_metadata_in_tx`'s
/// `constraint_column_usage` join used to key on `ccu.table_schema` (the
/// *referenced* table's schema) instead of `ccu.constraint_schema` (the
/// constraint's own schema, equal to the constraining table's schema) — so a
/// FK whose target lives in a different schema than its own table silently
/// lost all `key`/`references` metadata (`db::postgres::key_metadata_in_tx`).
#[tokio::test]
async fn cross_schema_foreign_key_reports_schema_qualified_reference() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect pool under test");

    for schema in [SCHEMA_E, SCHEMA_F] {
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
        "create table {SCHEMA_E}.parent (id int primary key); \
         create table {SCHEMA_F}.child (\
            id int primary key, \
            parent_id int references {SCHEMA_E}.parent(id), \
            same_schema_id int references {SCHEMA_F}.child(id)\
         );"
    )))
    .await
    .unwrap();

    let source = PgPoolSource::new(pool.clone());
    let opts = || QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };

    let data = source
        .query_table(Some(SCHEMA_F), "child", opts())
        .await
        .expect("query_table on the FK-holding table");

    let parent_id = data
        .columns
        .iter()
        .find(|c| c.name == "parent_id")
        .expect("parent_id column present");
    let refs = parent_id
        .references
        .as_ref()
        .expect("cross-schema FK must still report `references`, not be dropped");
    assert_eq!(refs.table, "parent");
    assert_eq!(refs.column, "id");
    assert_eq!(
        refs.schema.as_deref(),
        Some(SCHEMA_E),
        "cross-schema reference must carry the referenced table's schema"
    );

    // A same-schema FK on the same table must keep behaving exactly as
    // before: no `schema` field at all, not `Some(<own schema>)`.
    let same_schema_id = data
        .columns
        .iter()
        .find(|c| c.name == "same_schema_id")
        .expect("same_schema_id column present");
    let same_refs = same_schema_id
        .references
        .as_ref()
        .expect("same-schema FK must still report `references`");
    assert_eq!(same_refs.table, "child");
    assert_eq!(same_refs.column, "id");
    assert_eq!(
        same_refs.schema, None,
        "same-schema FK must omit `schema`, keeping the wire payload unchanged"
    );

    teardown_schemas(&pool, SCHEMA_E, SCHEMA_F).await;
}
