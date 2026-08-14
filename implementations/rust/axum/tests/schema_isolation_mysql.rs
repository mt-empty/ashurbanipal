//! MySQL analog of `schema_isolation.rs`. Unlike SQLite (single-schema
//! model, this file has no equivalent there), MySQL's schema/database
//! model is architecturally like Postgres's — so it needs the same three
//! regressions covered, adapted to MySQL's mechanisms:
//! - drift simulation via `after_connect` issuing `USE {database}`
//!   (MySQL's analog of `SET search_path`, since MySQL resolves unqualified
//!   table names against the connection's default database, not a
//!   searchable list);
//! - `information_schema.SCHEMATA`-based `list_schemas`/rejection;
//! - cross-schema FK reporting — MySQL's `KEY_COLUMN_USAGE` carries
//!   `REFERENCED_TABLE_SCHEMA` directly on each row, so the specific
//!   `ccu.table_schema`-vs-`ccu.constraint_schema` bug class the Postgres
//!   version guards against can't recur the same way here; this test is a
//!   positive assertion, not a regression for a known MySQL bug.
//!
//! Requires `MYSQL_TEST_URL` (see `.devcontainer/docker-compose.yml`).
//! Not run in CI — same zero-CI-footprint precedent as the rest of the
//! `mysql` feature (see `docs/adapter-decisions.md`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ashurbanipal_axum::{DbSource, MySqlSource, QueryOpts};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::{Executor, MySqlPool};

const SCHEMA_A: &str = "ashb_test_schema_isolation_a";
const SCHEMA_B: &str = "ashb_test_schema_isolation_b";
// A disjoint pair for the explicit-selection test below — cargo runs tests
// in the same binary concurrently by default, so sharing SCHEMA_A/SCHEMA_B
// with the drift test races on `create database`.
const SCHEMA_C: &str = "ashb_test_schema_isolation_c";
const SCHEMA_D: &str = "ashb_test_schema_isolation_d";
// Own pair for the cross-schema FK test below, same reasoning as C/D.
const SCHEMA_E: &str = "ashb_test_schema_isolation_e";
const SCHEMA_F: &str = "ashb_test_schema_isolation_f";

async fn setup_schemas(test_url: &str, schema_a: &str, schema_b: &str) {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(test_url)
        .await
        .expect("connect for schema setup");

    for schema in [schema_a, schema_b] {
        pool.execute(sqlx::AssertSqlSafe(format!(
            "drop database if exists {schema}"
        )))
        .await
        .unwrap();
        pool.execute(sqlx::AssertSqlSafe(format!("create database {schema}")))
            .await
            .unwrap();
    }

    // MySQL has no multi-statement-per-execute() without opting into
    // CLIENT_MULTI_STATEMENTS — every DDL/DML statement here is its own call.
    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {schema_a}.probe_isolation (id int primary key, marker varchar(50))"
    )))
    .await
    .unwrap();
    pool.execute(sqlx::AssertSqlSafe(format!(
        "insert into {schema_a}.probe_isolation values (1, 'A'), (2, 'A')"
    )))
    .await
    .unwrap();

    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {schema_b}.probe_isolation \
         (id int primary key, marker varchar(50), extra varchar(50))"
    )))
    .await
    .unwrap();
    pool.execute(sqlx::AssertSqlSafe(format!(
        "insert into {schema_b}.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X')"
    )))
    .await
    .unwrap();
}

async fn teardown_schemas(pool: &MySqlPool, schema_a: &str, schema_b: &str) {
    for schema in [schema_a, schema_b] {
        pool.execute(sqlx::AssertSqlSafe(format!(
            "drop database if exists {schema}"
        )))
        .await
        .ok();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn query_table_never_mixes_schemas_across_pooled_connections() {
    let test_url = std::env::var("MYSQL_TEST_URL")
        .expect("MYSQL_TEST_URL must be set (the devcontainer sets it automatically)");

    setup_schemas(&test_url, SCHEMA_A, SCHEMA_B).await;

    // Alternates each newly-opened physical connection's default database
    // between the two schemas, simulating a host pool whose sessions don't
    // all agree on which database `select database()` resolves to.
    let connection_count = Arc::new(AtomicUsize::new(0));
    let pool = MySqlPoolOptions::new()
        .min_connections(2)
        .max_connections(2)
        .after_connect(move |conn, _meta| {
            let connection_count = connection_count.clone();
            Box::pin(async move {
                let n = connection_count.fetch_add(1, Ordering::SeqCst);
                let schema = if n % 2 == 0 { SCHEMA_A } else { SCHEMA_B };
                conn.execute(sqlx::AssertSqlSafe(format!("use {schema}")))
                    .await?;
                Ok(())
            })
        })
        .connect(&test_url)
        .await
        .expect("connect pool under test");

    // Force both physical connections to actually be established before
    // the concurrent calls below, so both schemas are represented in the
    // pool's idle set.
    let (c1, c2) = tokio::join!(pool.acquire(), pool.acquire());
    drop(c1.unwrap());
    drop(c2.unwrap());

    let source = MySqlSource::new(pool.clone());

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
    let test_url = std::env::var("MYSQL_TEST_URL")
        .expect("MYSQL_TEST_URL must be set (the devcontainer sets it automatically)");

    setup_schemas(&test_url, SCHEMA_C, SCHEMA_D).await;

    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&test_url)
        .await
        .expect("connect pool under test");
    let source = MySqlSource::new(pool.clone());

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
        matches!(rejected, Err(ashurbanipal_axum::DbError::NotAllowed(_))),
        "an unknown schema must be rejected before touching SQL text, not passed through"
    );

    let schemas = source.list_schemas().await.unwrap();
    assert!(schemas.contains(&SCHEMA_C.to_string()));
    assert!(schemas.contains(&SCHEMA_D.to_string()));
    assert!(
        !schemas.iter().any(|s| {
            matches!(
                s.as_str(),
                "mysql" | "information_schema" | "performance_schema" | "sys"
            )
        }),
        "system schemas must never be offered as selectable"
    );

    teardown_schemas(&pool, SCHEMA_C, SCHEMA_D).await;
}

/// Positive assertion, not a regression test for a known bug (unlike the
/// Postgres version): MySQL's `information_schema.KEY_COLUMN_USAGE` carries
/// `REFERENCED_TABLE_SCHEMA`/`REFERENCED_TABLE_NAME`/`REFERENCED_COLUMN_NAME`
/// directly on each row, so there's no separate join to a
/// `constraint_column_usage`-equivalent table where a wrong-schema-column
/// bug could hide.
#[tokio::test]
async fn cross_schema_foreign_key_reports_schema_qualified_reference() {
    let test_url = std::env::var("MYSQL_TEST_URL")
        .expect("MYSQL_TEST_URL must be set (the devcontainer sets it automatically)");

    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&test_url)
        .await
        .expect("connect pool under test");

    for schema in [SCHEMA_E, SCHEMA_F] {
        pool.execute(sqlx::AssertSqlSafe(format!(
            "drop database if exists {schema}"
        )))
        .await
        .unwrap();
        pool.execute(sqlx::AssertSqlSafe(format!("create database {schema}")))
            .await
            .unwrap();
    }
    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {SCHEMA_E}.parent (id int primary key)"
    )))
    .await
    .unwrap();
    // Inline column-level `references` is parsed but silently NOT enforced
    // or registered as a real constraint by MySQL/InnoDB — an explicit
    // table-level `foreign key (...) references ...` clause is required for
    // it to actually appear in information_schema.KEY_COLUMN_USAGE.
    pool.execute(sqlx::AssertSqlSafe(format!(
        "create table {SCHEMA_F}.child (\
            id int primary key, \
            parent_id int, \
            same_schema_id int, \
            foreign key (parent_id) references {SCHEMA_E}.parent(id), \
            foreign key (same_schema_id) references {SCHEMA_F}.child(id)\
         )"
    )))
    .await
    .unwrap();

    let source = MySqlSource::new(pool.clone());
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
        .expect("cross-schema FK must report `references`");
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
