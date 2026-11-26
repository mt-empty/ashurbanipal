//! Every operation runs in a read-only transaction (spec/protocol.md §6).
//! A row-level security policy that calls a writing function is the one way
//! a plain `SELECT` on a listed table can write, so reading such a table must
//! fail and leave nothing written. RLS does not apply to a superuser, so the
//! source's sessions `set role` to an ordinary role in `after_connect`.

use ashurbanipal_axum::{DbError, DbSource, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

mod pg_cleanup;
use pg_cleanup::PgCleanup;

const SCHEMA: &str = "ashb_test_rust_read_only_tx";
const ROLE: &str = "ashb_test_rust_read_only_tx_role";

async fn setup(database_url: &str) -> (PgPool, PgCleanup) {
    let cleanup = PgCleanup::new(database_url, &[SCHEMA], &[ROLE]);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for setup");
    // The role may insert into `audit`, so only the read-only transaction
    // can stop the policy's write.
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {SCHEMA} cascade; \
         drop role if exists {ROLE}; \
         create role {ROLE} nosuperuser; \
         grant {ROLE} to current_user; \
         create schema {SCHEMA}; \
         grant usage on schema {SCHEMA} to {ROLE}; \
         create table {SCHEMA}.audit (id serial primary key); \
         grant insert on {SCHEMA}.audit to {ROLE}; \
         grant usage on sequence {SCHEMA}.audit_id_seq to {ROLE}; \
         create function {SCHEMA}.log_read() returns boolean language sql volatile \
           as $$ insert into {SCHEMA}.audit default values; select true $$; \
         create table {SCHEMA}.watched (id int primary key); \
         insert into {SCHEMA}.watched values (1); \
         alter table {SCHEMA}.watched enable row level security; \
         create policy log_every_read on {SCHEMA}.watched for select to {ROLE} \
           using ({SCHEMA}.log_read()); \
         grant select on {SCHEMA}.watched to {ROLE};"
    )))
    .await
    .expect("setup schema/role");
    (pool, cleanup)
}

#[tokio::test]
async fn a_select_that_would_write_fails_and_writes_nothing() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let (admin, _cleanup) = setup(&database_url).await;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                conn.execute(sqlx::AssertSqlSafe(format!("set role {ROLE}")))
                    .await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await
        .expect("connect role pool");
    let source = PgPoolSource::new(pool);

    let result = source
        .query_table(
            Some(SCHEMA),
            "watched",
            QueryOpts {
                limit: 10,
                offset: 0,
                sort: None,
                descending: false,
                timeout_secs: 5,
                filter: None,
            },
        )
        .await;
    match result {
        Err(DbError::Sqlx(sqlx::Error::Database(e))) => {
            assert_eq!(e.code().as_deref(), Some("25006"), "{e}");
        }
        other => panic!("expected a read-only transaction error, got {other:?}"),
    }

    let written: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from {SCHEMA}.audit"
    )))
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(written, 0);
}
