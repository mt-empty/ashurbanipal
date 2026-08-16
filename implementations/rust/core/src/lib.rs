//! Framework-agnostic core for Ashurbanipal — config/kill-switch, `DbSource`
//! backends, and filter-DSL validation, with no HTTP framework dependency.
//! `ashurbanipal-axum` (and any future framework adapter) re-exports this
//! crate's public API unchanged; see `docs/design.md` for the full design.

pub mod config;
pub mod db;
pub mod filter;

pub use config::{Config, ConfigError, Limits, Sibling};
#[cfg(feature = "mysql")]
pub use db::MySqlSource;
#[cfg(feature = "postgres")]
pub use db::PgPoolSource;
#[cfg(feature = "sqlite")]
pub use db::SqliteSource;
pub use db::{ColumnInfo, DbError, DbSource, QueryOpts, TableData, TableInfo};
pub use filter::{Condition, FilterError, FilterOp, Logic};

#[cfg(not(any(feature = "postgres", feature = "sqlite", feature = "mysql")))]
compile_error!(
    "ashurbanipal: enable at least one of the `postgres`, `sqlite`, or `mysql` features"
);
