//! Regression test for a table with inheritance children: a plain `select` on
//! it returns the children's rows too, so its row estimate, keys and common
//! values must describe those rows, not only its own.

use std::collections::HashMap;

use ashurbanipal_axum::{DbSource, PgPoolSource, QueryOpts};
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Executor;

mod pg_cleanup;
use pg_cleanup::PgCleanup;

const SCHEMA: &str = "ashb_test_inheritance_parent";

fn opts() -> QueryOpts {
    QueryOpts {
        limit: 500,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    }
}

async fn exec(pool: &PgPool, sql: &str) {
    pool.execute(sqlx::AssertSqlSafe(sql.replace("$s", SCHEMA)))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn estimates(source: &PgPoolSource) -> (i64, HashMap<String, i64>) {
    let total = source
        .query_table(Some(SCHEMA), "tickets", opts())
        .await
        .expect("query_table on the parent")
        .total_approx;
    let counts = source
        .table_counts(Some(SCHEMA))
        .await
        .expect("table_counts")
        .into_iter()
        .collect();
    (total, counts)
}

async fn common_values(source: &PgPoolSource, table: &str) -> HashMap<String, f32> {
    source
        .common_values(Some(SCHEMA), table, "status")
        .await
        .expect("common_values")
        .into_iter()
        .collect()
}

#[tokio::test]
async fn an_inheritance_parent_describes_its_childrens_rows_too() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let _cleanup = PgCleanup::new(&database_url, &[SCHEMA], &[]);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect for setup");
    // Three levels: tickets (30 rows: open/pending/closed), tickets_archive
    // (70: archived/closed) and tickets_purged (20: purged). Ids repeat across
    // them, so the parent's primary key does not hold. Autovacuum is off so
    // each table's statistics change only when the test analyzes it.
    exec(
        &pool,
        "drop schema if exists $s cascade; \
         create schema $s; \
         create table $s.tickets (id int primary key, status text not null) \
             with (autovacuum_enabled = false); \
         create table $s.tickets_archive (id int not null, status text not null) \
             with (autovacuum_enabled = false); \
         create table $s.tickets_purged () inherits ($s.tickets_archive) \
             with (autovacuum_enabled = false); \
         create table $s.lone (id int primary key); \
         insert into $s.tickets \
             select g, (array['open','pending','closed'])[g % 3 + 1] from generate_series(1, 30) g; \
         insert into $s.tickets_archive \
             select g, (array['archived','closed'])[g % 2 + 1] from generate_series(1, 70) g; \
         insert into $s.tickets_purged select g, 'purged' from generate_series(1, 20) g;",
    )
    .await;
    let source = PgPoolSource::new(pool.clone());

    // The parent is analyzed while it has no children, so it has only its own
    // statistics row; then the archive (and its child) is attached.
    exec(
        &pool,
        "analyze $s.tickets; alter table $s.tickets_archive inherit $s.tickets;",
    )
    .await;
    let (total, counts) = estimates(&source).await;
    assert_eq!(total, 30, "children with no estimate yet add nothing");
    assert_eq!(
        counts["tickets_archive"], -1,
        "no table in its tree has one"
    );
    assert!(
        common_values(&source, "tickets").await.is_empty(),
        "no with-children statistics row yet, so no common values"
    );

    exec(
        &pool,
        "analyze $s.tickets; analyze $s.tickets_archive; analyze $s.tickets_purged;",
    )
    .await;
    let table = source
        .query_table(Some(SCHEMA), "tickets", opts())
        .await
        .expect("query_table on the parent");
    assert_eq!(table.rows.len(), 120, "all three levels' rows");
    let id = table.columns.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(
        id.key, None,
        "the parent's primary key does not hold over its children's rows"
    );
    let lone = source
        .query_table(Some(SCHEMA), "lone", opts())
        .await
        .expect("query_table on a table without children");
    assert_eq!(serde_json::to_value(&lone.columns[0]).unwrap()["key"], "pk");

    let (total, counts) = estimates(&source).await;
    assert_eq!(total, 120, "the estimate sums every descendant");
    assert_eq!(counts["tickets"], 120, "same figure as total_approx");
    assert_eq!(counts["tickets_archive"], 90);
    assert_eq!(counts["tickets_purged"], 20);

    let parent = common_values(&source, "tickets").await;
    assert_eq!(parent.len(), 5, "every level's values; got {parent:?}");
    assert!(
        (parent["closed"] - 0.375).abs() < 0.001,
        "10 of the parent's rows and 35 of the archive's, out of 120; got {parent:?}"
    );
    assert_eq!(common_values(&source, "tickets_purged").await.len(), 1);
}
