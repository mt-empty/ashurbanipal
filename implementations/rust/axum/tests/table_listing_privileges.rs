//! Regression test for the table listing / allow-list privilege gate
//! (spec/protocol.md §5.2): `/api/tables`, `/api/table-counts`, and the
//! `table`-parameter allow-list must all exclude tables the connected role
//! cannot `SELECT`, so the sidebar never offers a table a data request
//! would then reject — and an `INSERT`-only table must come back as
//! `NotAllowed` (→ 400), never a raw `permission denied` 500.
//!
//! Runs every session as an under-privileged role (`set role` in
//! `after_connect`) with `USAGE` on a throwaway schema but `SELECT` on
//! only one of its three tables.

use ashurbanipal_axum::{DbError, DbSource, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

const SCHEMA: &str = "ashb_test_table_privileges";
const ROLE: &str = "ashb_test_table_privileges_role";

async fn setup(database_url: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for setup");

    // One statement batch, idempotent — a prior aborted run may have left
    // the schema or role behind. `grant {ROLE} to current_user` is what
    // lets the setup session `set role` to it in `after_connect` below.
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {SCHEMA} cascade; \
         drop role if exists {ROLE}; \
         create role {ROLE} nosuperuser; \
         grant {ROLE} to current_user; \
         create schema {SCHEMA}; \
         grant usage on schema {SCHEMA} to {ROLE}; \
         create table {SCHEMA}.readable (id int primary key, name text); \
         insert into {SCHEMA}.readable values (1, 'a'), (2, 'b'); \
         create table {SCHEMA}.write_only (id int primary key); \
         create table {SCHEMA}.no_grant (id int primary key); \
         grant select on {SCHEMA}.readable to {ROLE}; \
         grant insert on {SCHEMA}.write_only to {ROLE};"
    )))
    .await
    .expect("setup schema/role");
    pool
}

async fn teardown(pool: &PgPool) {
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {SCHEMA} cascade; drop role if exists {ROLE};"
    )))
    .await
    .ok();
}

#[tokio::test]
async fn listing_and_allow_list_exclude_non_selectable_tables() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

    let admin_pool = setup(&database_url).await;

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                conn.execute(sqlx::AssertSqlSafe(format!("set role {ROLE}")))
                    .await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await
        .expect("connect under-privileged pool");
    let source = PgPoolSource::new(pool.clone());

    let opts = || QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };

    let tables = source.list_tables(Some(SCHEMA)).await.expect("list_tables");
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["readable"],
        "list_tables must omit write_only (INSERT only) and no_grant (no privilege)"
    );

    let counts = source
        .table_counts(Some(SCHEMA))
        .await
        .expect("table_counts");
    let counted: Vec<&str> = counts.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(
        counted,
        vec!["readable"],
        "table_counts must track the same set as list_tables"
    );

    source
        .query_table(Some(SCHEMA), "readable", opts())
        .await
        .expect("the SELECT-able table queries fine");

    assert!(
        matches!(
            source.query_table(Some(SCHEMA), "write_only", opts()).await,
            Err(DbError::NotAllowed(_))
        ),
        "an INSERT-only table must be rejected as NotAllowed, not reach a permission-denied 500"
    );

    assert!(
        matches!(
            source.query_table(Some(SCHEMA), "no_grant", opts()).await,
            Err(DbError::NotAllowed(_))
        ),
        "a table the role has no privilege on must be rejected as NotAllowed"
    );

    teardown(&admin_pool).await;
}
