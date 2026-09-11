//! Regression tests for `spec/protocol.md` §5.9 on partitioned tables:
//! Postgres copies an inherited FK constraint onto every partition, and
//! `list_tables`'s `information_schema` gate is broader than the
//! `relkind = 'r'` filter §5.2 (and so §5.9's own table-gate) is meant to
//! enforce.

use ashurbanipal_axum::{DbError, DbSource, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

// Each test gets its own schema name — the two run concurrently (cargo
// test's default), and a shared name races two `create schema` calls
// against each other.
const SCHEMA_DUP: &str = "ashb_test_referenced_by_partitioning_dup";
const SCHEMA_GATE: &str = "ashb_test_referenced_by_partitioning_gate";
const SCHEMA_QUERY_TABLE_GATE: &str = "ashb_test_query_table_partitioning_gate";

async fn setup(database_url: &str, schema: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("connect for setup");

    // `events` is range-partitioned with two partitions and one FK to
    // `users`; Postgres inherits that constraint onto each partition, so
    // `pg_constraint` holds three rows (parent + 2 children) for what is,
    // to the API, a single relationship.
    pool.execute(sqlx::AssertSqlSafe(format!(
        "drop schema if exists {schema} cascade; \
         create schema {schema}; \
         create table {schema}.users (id int primary key); \
         create table {schema}.events ( \
             id bigint not null, \
             user_id int references {schema}.users(id) \
         ) partition by range (id); \
         create table {schema}.events_p1 partition of {schema}.events for values from (1) to (1000); \
         create table {schema}.events_p2 partition of {schema}.events for values from (1000) to (2000);"
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

#[tokio::test]
async fn referenced_by_reports_one_entry_for_a_partitioned_referrer_not_one_per_partition() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let admin_pool = setup(&database_url, SCHEMA_DUP).await;
    let source = PgPoolSource::new(admin_pool.clone());

    let refs = source
        .referenced_by(Some(SCHEMA_DUP), "users")
        .await
        .expect("referenced_by");
    let events: Vec<_> = refs
        .iter()
        .filter(|r| r.table.starts_with("events"))
        .collect();
    assert_eq!(
        events.len(),
        1,
        "a partitioned referrer's inherited FK copies must collapse to one \
         logical entry, got {events:?}"
    );
    assert_eq!(
        events[0].table, "events",
        "the reported referrer must be the partitioned parent, not a child partition"
    );

    teardown(&admin_pool, SCHEMA_DUP).await;
}

#[tokio::test]
async fn referenced_by_rejects_a_partitioned_table_as_target_same_as_any_unlisted_table() {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let admin_pool = setup(&database_url, SCHEMA_GATE).await;
    let source = PgPoolSource::new(admin_pool.clone());

    // spec/protocol.md §5.9 requires `table` to match a §5.2 (list_tables)
    // entry, and list_tables' relkind = 'r' filter excludes partitioned
    // tables — so this must reject the same way an unknown table name does,
    // not silently answer `[]`.
    assert!(
        matches!(
            source.referenced_by(Some(SCHEMA_GATE), "events").await,
            Err(DbError::NotAllowed(_))
        ),
        "a partitioned table must be rejected as NotAllowed, matching §5.2's own listing"
    );

    teardown(&admin_pool, SCHEMA_GATE).await;
}

#[tokio::test]
async fn query_table_rejects_a_partitioned_table_same_as_referenced_by_does() {
    // finding #1: `query_table` (and `common_values`, same gate) validate
    // `table` against `allowed_tables_in_tx`, which — unlike `list_tables`'
    // own `relkind = 'r'` filter — matches `information_schema.tables`'
    // `BASE TABLE`, a broader set that includes partitioned tables. So a
    // partitioned table must be rejected here too, not silently queried.
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let admin_pool = setup(&database_url, SCHEMA_QUERY_TABLE_GATE).await;
    let source = PgPoolSource::new(admin_pool.clone());

    let opts = QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };
    assert!(
        matches!(
            source
                .query_table(Some(SCHEMA_QUERY_TABLE_GATE), "events", opts)
                .await,
            Err(DbError::NotAllowed(_))
        ),
        "a partitioned table must be rejected as NotAllowed, matching list_tables' own listing"
    );

    teardown(&admin_pool, SCHEMA_QUERY_TABLE_GATE).await;
}
