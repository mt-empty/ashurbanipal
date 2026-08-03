//! Ashurbanipal — a self-contained, embeddable, read-only database browser
//! for development, integration, and staging environments.
//!
//! A host service embeds this crate, merges its [`router`] into its own Axum
//! app, and gets a web UI for browsing its own Postgres tables:
//!
//! ```no_run
//! # async fn example(pool: sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
//! let config = ashurbanipal::Config::from_toml(r#"
//!     environment = "dev"
//!     enabled_for = ["dev", "integration"]
//! "#)?;
//! let app: axum::Router = axum::Router::new()
//!     .merge(ashurbanipal::router(config, ashurbanipal::PgPoolSource::new(pool)));
//! # Ok(()) }
//! ```
//!
//! Read-only, schema-validated, parameterized; disabled everywhere unless
//! explicitly enabled, and impossible to enable in production (rejected at
//! config-parse time). See `docs/design.md` for the full design.

mod config;
mod db;
mod filter;
mod routes;

pub use config::{Config, ConfigError, Limits, Sibling};
#[cfg(feature = "sqlite")]
pub use db::SqliteSource;
pub use db::{ColumnInfo, DbError, DbSource, PgPoolSource, QueryOpts, TableData, TableInfo};
pub use filter::{Condition, FilterError, FilterOp, Logic};
pub use routes::router;
