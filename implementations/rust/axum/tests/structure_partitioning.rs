//! Regression tests for `spec/protocol.md` §5.10 against Postgres catalog
//! quirks: partitioned tables (parent rejected, child reports its own
//! copies) and index shapes (`INCLUDE` columns, expression entries).

use ashurbanipal_axum::{DbError, DbSource, PgPoolSource};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

// One schema per test: they run concurrently, and a shared name races two
// `create schema` calls against each other.
const SCHEMA_PARTITIONS: &str = "ashb_test_structure_partitions";
const SCHEMA_INDEXES: &str = "ashb_test_structure_indexes";

async fn setup(schema: &str, ddl: &str) -> PgPool {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = PgPoolOptions::new()
        .max_connections(1)
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

#[tokio::test]
async fn partitioned_parent_is_rejected_and_a_child_reports_its_own_copies() {
    let s = SCHEMA_PARTITIONS;
    let pool = setup(
        s,
        &format!(
            "create table {s}.users (id int primary key); \
             create table {s}.events ( \
                 id bigint not null, \
                 user_id int references {s}.users(id) \
             ) partition by range (id); \
             create index events_user_idx on {s}.events (user_id); \
             create table {s}.events_p1 partition of {s}.events for values from (1) to (1000);"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());

    assert!(
        matches!(
            source.structure(Some(s), "events").await,
            Err(DbError::NotAllowed(_))
        ),
        "a partitioned parent must be rejected like any unlisted table"
    );

    let child = source
        .structure(Some(s), "events_p1")
        .await
        .expect("structure of a partition child");
    assert!(
        child
            .indexes
            .iter()
            .any(|i| i.columns == ["user_id".to_string()]),
        "the child's inherited index is its own and must be reported: {:?}",
        child.indexes
    );
    let fk = child
        .constraints
        .foreign_keys
        .iter()
        .find(|f| f.columns.len() == 1 && f.columns[0].from == "user_id")
        .unwrap_or_else(|| panic!("child FK missing: {:?}", child.constraints.foreign_keys));
    assert_eq!(fk.table, "users");
    assert!(fk.schema.is_none());

    teardown(&pool, s).await;
}

#[tokio::test]
async fn index_columns_exclude_include_columns_and_keep_expression_entries() {
    let s = SCHEMA_INDEXES;
    let pool = setup(
        s,
        &format!(
            "create table {s}.items (id int primary key, email text, a int, b int, status text); \
             create index items_cover_idx on {s}.items (a) include (b); \
             create index items_expr_only_idx on {s}.items (lower(email)); \
             create index items_mixed_idx on {s}.items (lower(email), a); \
             create index items_partial_idx on {s}.items (a) where status = 'open';"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());
    let structure = source.structure(Some(s), "items").await.expect("structure");
    let index = |name: &str| {
        structure
            .indexes
            .iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("index {name} missing: {:?}", structure.indexes))
    };

    assert_eq!(
        index("items_cover_idx").columns,
        ["a"],
        "INCLUDE column leaked"
    );
    assert_eq!(index("items_expr_only_idx").columns.len(), 1);
    assert!(index("items_expr_only_idx").columns[0].contains("lower"));
    let mixed = &index("items_mixed_idx").columns;
    assert_eq!(
        mixed.len(),
        2,
        "expression entry must keep its position: {mixed:?}"
    );
    assert!(mixed[0].contains("lower") && mixed[1] == "a");
    assert!(index("items_partial_idx")
        .predicate
        .as_deref()
        .is_some_and(|p| p.contains("open")));
    assert!(index("items_cover_idx").predicate.is_none());

    teardown(&pool, s).await;
}
