//! Ashurbanipal — a self-contained, embeddable, read-only database browser
//! for development, integration, and staging environments.
//!
//! A host service embeds this crate, merges its [`router`] into its own Axum
//! app, and gets a web UI for browsing its own Postgres tables:
//!
//! ```no_run
//! # async fn example(pool: sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
//! let config = ashurbanipal_axum::Config::from_toml(r#"
//!     environment = "dev"
//!     enabled_for = ["dev", "integration"]
//! "#)?;
//! let app: axum::Router = axum::Router::new()
//!     .merge(ashurbanipal_axum::router(config, ashurbanipal_axum::PgPoolSource::new(pool)));
//! # Ok(()) }
//! ```
//!
//! Read-only, schema-validated, parameterized; disabled everywhere unless
//! explicitly enabled, and impossible to enable in production (rejected at
//! config-parse time). See `docs/design.md` for the full design.

mod routes;

#[cfg(feature = "mysql")]
pub use ashurbanipal::MySqlSource;
#[cfg(feature = "sqlite")]
pub use ashurbanipal::SqliteSource;
pub use ashurbanipal::{
    ColumnInfo, DbError, DbSource, PgPoolSource, QueryOpts, TableData, TableInfo,
};
pub use ashurbanipal::{Condition, FilterError, FilterOp, Logic};
pub use ashurbanipal::{Config, ConfigError, Limits, Sibling};
pub use routes::router;
