//! `spec/protocol.md` §5.11 against Postgres catalog types the conformance
//! seed cannot vary: enum identity, arrays, and the timeout label.

use ashurbanipal_axum::{DbError, DbSource, JoinOpts, JoinSpec, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

// One schema per test: they run concurrently.
const SCHEMA_TYPES: &str = "ashb_test_join_types";
const SCHEMA_SLOW: &str = "ashb_test_join_slow";
const SCHEMA_COLLATION: &str = "ashb_test_join_collation";
const SCHEMA_SORT: &str = "ashb_test_join_sort";

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

fn table_opts() -> QueryOpts {
    QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    }
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

// Postgres rejects a comparison of two different explicit collations, while
// the default collation yields to an explicit one; the metadata reports only
// the explicit ones.
#[tokio::test]
async fn text_columns_with_clashing_collations_do_not_join() {
    let s = SCHEMA_COLLATION;
    let pool = setup(
        s,
        &format!(
            "create table {s}.a (id int primary key, c text collate \"C\", p text collate \"POSIX\", d text); \
             create table {s}.b (id int primary key, c text collate \"C\", p text collate \"C\", d text); \
             insert into {s}.a values (1, 'x', 'x', 'x'); \
             insert into {s}.b values (1, 'x', 'x', 'x');"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());

    let data = source
        .query_table(Some(s), "a", table_opts())
        .await
        .unwrap();
    let collations: Vec<_> = data
        .columns
        .iter()
        .map(|c| c.collation.as_deref())
        .collect();
    assert_eq!(collations, [None, Some("C"), Some("POSIX"), None]);

    for (left, right) in [("c", "c"), ("c", "d"), ("d", "c"), ("d", "d")] {
        let joined = source
            .query_join(Some(s), &on("a", left, "b", right), opts(5))
            .await
            .unwrap();
        assert_eq!(joined.rows.len(), 1, "{left} to {right}");
    }
    let clash = source
        .query_join(Some(s), &on("a", "p", "b", "p"), opts(5))
        .await;
    assert!(
        matches!(&clash, Err(DbError::BadJoin(m)) if m.contains("different text collations")),
        "expected a collation clash, got {clash:?}"
    );

    teardown(&pool, s).await;
}

// A `json`, `xml` or geometric column has no ordering operator, so a sort on
// it is a 400 `unsortable_column`, not a 500; `jsonb` sorts, and a domain over
// it reports the `json` class.
#[tokio::test]
async fn sorting_an_unorderable_column_is_a_client_error() {
    let s = SCHEMA_SORT;
    let pool = setup(
        s,
        &format!(
            "create domain {s}.settings as jsonb; \
             create table {s}.a (id int primary key, doc json, bag jsonb, dom {s}.settings); \
             create table {s}.b (id int primary key); \
             insert into {s}.a values (1, '{{}}', '{{}}', '{{}}'), (2, '[]', '[]', '[]'); \
             insert into {s}.b values (1);"
        ),
    )
    .await;
    let source = PgPoolSource::new(pool.clone());
    let sorted_by = |column: &str| QueryOpts {
        sort: Some(column.into()),
        ..table_opts()
    };

    let err = source
        .query_table(Some(s), "a", sorted_by("doc"))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, DbError::Unsortable(c) if c == "doc"),
        "{err:?}"
    );
    assert_eq!(
        err.problem(),
        (
            400,
            "unsortable_column",
            "cannot sort by doc: its type has no ordering".to_string()
        )
    );

    let mut join_opts = opts(5);
    join_opts.sort = Some("doc".into());
    join_opts.sort_join = Some(0);
    let err = source
        .query_join(Some(s), &on("a", "id", "b", "id"), join_opts)
        .await
        .unwrap_err();
    assert!(matches!(err, DbError::Unsortable(_)), "{err:?}");

    for column in ["bag", "dom", "id"] {
        source
            .query_table(Some(s), "a", sorted_by(column))
            .await
            .unwrap_or_else(|e| panic!("sorting by {column}: {e:?}"));
    }
    let table = source
        .query_table(Some(s), "a", table_opts())
        .await
        .unwrap();
    let wire = serde_json::to_value(&table.columns).unwrap();
    assert_eq!(wire[3]["class"], "json");

    teardown(&pool, s).await;
}
