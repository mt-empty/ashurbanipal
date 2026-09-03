//! MySQL/MariaDB analog of `table_listing_privileges.rs`.
//!
//! Neither engine has a `has_table_privilege` function, and every
//! `information_schema`-based privilege view is either role-blind or needs
//! privileges an embedded least-privilege role won't have (see
//! `docs/adapter-decisions.md` §5.2/§5.3). So the listing is *not* gated
//! here — an `INSERT`-only table still appears in `/api/tables`, exactly as
//! `information_schema.tables` reports it. What this test pins is the other
//! half: the residual `ER_TABLEACCESS_DENIED_ERROR` (1142) at the row
//! fetch must surface as `NotAllowed` (→ 400), never a raw driver 500.
//!
//! Requires `MYSQL_TEST_URL` / `MARIADB_TEST_URL` (see
//! `.devcontainer/docker-compose.yml`). Not run in CI — same
//! zero-CI-footprint precedent as the rest of the `mysql` feature.

use ashurbanipal_axum::{DbError, DbSource, MySqlSource, QueryOpts};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::{Executor, MySqlPool};

mod common;
use common::MysqlCleanup;

const SCHEMA: &str = "ashb_test_table_privileges";
const USER: &str = "ashb_test_table_privileges_user";
const PASSWORD: &str = "ashb_test_pw";

/// Rewrite a `mysql://root:pw@host/db` URL to connect as the throwaway
/// least-privilege user against the throwaway schema — that user has no
/// privilege on the devcontainer's default `ashurbanipal` database, so the
/// default-DB in the original URL would fail the connection outright.
fn as_limited_user(url: &str, user: &str, password: &str) -> String {
    let (scheme, rest) = url.split_once("://").expect("url has a scheme");
    let after_userinfo = rest.rsplit_once('@').map_or(rest, |(_, tail)| tail);
    let host = after_userinfo
        .split_once('/')
        .map_or(after_userinfo, |(h, _)| h);
    format!("{scheme}://{user}:{password}@{host}/{SCHEMA}")
}

async fn setup(admin_url: &str) -> MySqlPool {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(admin_url)
        .await
        .expect("connect for setup");

    // MySQL has no multi-statement execute() without CLIENT_MULTI_STATEMENTS.
    for stmt in [
        format!("drop database if exists {SCHEMA}"),
        format!("drop user if exists '{USER}'@'%'"),
        format!("create database {SCHEMA}"),
        format!("create user '{USER}'@'%' identified by '{PASSWORD}'"),
        format!("create table {SCHEMA}.readable (id int primary key, name varchar(50))"),
        format!("insert into {SCHEMA}.readable values (1, 'a'), (2, 'b')"),
        format!("create table {SCHEMA}.write_only (id int primary key)"),
        format!("create table {SCHEMA}.no_grant (id int primary key)"),
        format!("grant select on {SCHEMA}.readable to '{USER}'@'%'"),
        format!("grant insert on {SCHEMA}.write_only to '{USER}'@'%'"),
    ] {
        pool.execute(sqlx::AssertSqlSafe(stmt))
            .await
            .expect("setup database/user");
    }
    pool
}

async fn run(admin_url: &str) {
    setup(admin_url).await;
    let _cleanup = MysqlCleanup {
        url: admin_url.to_string(),
        statements: vec![
            format!("drop database if exists {SCHEMA}"),
            format!("drop user if exists '{USER}'@'%'"),
        ],
    };

    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&as_limited_user(admin_url, USER, PASSWORD))
        .await
        .expect("connect least-privilege pool");
    let source = MySqlSource::new(pool.clone());

    let opts = || QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    };

    let names: Vec<String> = source
        .list_tables(Some(SCHEMA))
        .await
        .expect("list_tables")
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(names.contains(&"readable".to_string()));
    // Documented gap: information_schema.tables lists a table the role holds
    // *any* privilege on, and there's no cheap role-aware way to narrow it
    // to SELECT — so write_only is still offered. Clicking it is what the
    // 1142 mapping below makes safe. If this ever flips, update
    // docs/adapter-decisions.md.
    assert!(
        names.contains(&"write_only".to_string()),
        "MySQL cannot yet gate the listing on SELECT privilege"
    );
    assert!(
        !names.contains(&"no_grant".to_string()),
        "a table the role has zero privilege on is not catalog-visible anyway"
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
        "an INSERT-only table must come back as NotAllowed, not a raw permission-denied 500"
    );

    assert!(
        matches!(
            source.query_table(Some(SCHEMA), "no_grant", opts()).await,
            Err(DbError::NotAllowed(_))
        ),
        "a table absent from the allow-list must be rejected as NotAllowed"
    );
}

#[tokio::test]
async fn mysql_maps_select_denied_to_not_allowed() {
    let url = std::env::var("MYSQL_TEST_URL")
        .expect("MYSQL_TEST_URL must be set (the devcontainer sets it automatically)");
    run(&url).await;
}

#[tokio::test]
async fn mariadb_maps_select_denied_to_not_allowed() {
    let Ok(url) = std::env::var("MARIADB_TEST_URL") else {
        eprintln!("MARIADB_TEST_URL not set — skipping");
        return;
    };
    run(&url).await;
}
