//! Regression tests for a NUL byte reaching Postgres in two different wire
//! positions, each with its own correct outcome (spec/protocol.md §5.2,
//! §5.4.2):
//!
//! - In the `table` **identifier**: no real relname could ever contain one,
//!   so it MUST come back as `NotAllowed` (→ 400), never a raw 500.
//! - In a filter condition's **value**: a Postgres-only text-encoding limit,
//!   not a protocol-level one (`docs/adapter-decisions.md` §5.4.2) — still
//!   MUST 400, not 500.

use ashurbanipal_axum::{Condition, DbError, DbSource, FilterOp, PgPoolSource, QueryOpts};
use sqlx::postgres::PgPoolOptions;

const NUL_TABLE: &str = "ashb\0nul";

async fn source() -> PgPoolSource {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect");
    PgPoolSource::new(pool)
}

fn base_opts() -> QueryOpts {
    QueryOpts {
        limit: 10,
        offset: 0,
        sort: None,
        descending: false,
        timeout_secs: 5,
        filter: None,
    }
}

#[tokio::test]
async fn nul_byte_table_name_is_rejected_as_not_allowed_not_a_500() {
    let source = source().await;

    assert!(
        matches!(
            source.query_table(None, NUL_TABLE, base_opts()).await,
            Err(DbError::NotAllowed(_))
        ),
        "a NUL byte in table must be rejected as NotAllowed, not reach the driver as a raw 500"
    );

    assert!(
        matches!(
            source.common_values(None, NUL_TABLE, "id").await,
            Err(DbError::NotAllowed(_))
        ),
        "common_values must reject a NUL byte table the same way"
    );

    assert!(
        matches!(
            source.referenced_by(None, NUL_TABLE).await,
            Err(DbError::NotAllowed(_))
        ),
        "referenced_by must reject a NUL byte table the same way"
    );
}

#[tokio::test]
async fn nul_byte_filter_value_is_rejected_as_filter_parse_not_a_500() {
    let source = source().await;
    let opts = QueryOpts {
        filter: Some(vec![Condition {
            logic: None,
            not: false,
            column: "full_name".to_string(),
            op: FilterOp::Eq,
            value: Some("ashb\0nul".to_string()),
        }]),
        ..base_opts()
    };

    let result = source.query_table(None, "users", opts).await;
    assert!(
        matches!(result, Err(DbError::FilterParse(_))),
        "a NUL byte in a filter value must be rejected as FilterParse, not reach the driver as a raw 500: got {result:?}"
    );
}
