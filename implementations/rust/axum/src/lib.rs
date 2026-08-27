//! Ashurbanipal — a self-contained, embeddable, read-only database browser.
//!
//! A host service embeds this crate, merges its [`router`] into its own Axum
//! app, and gets a web UI for browsing its own database tables:
//!
//! ```no_run
//! # async fn example(pool: sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
//! let config = ashurbanipal_axum::Config::from_toml(r#"
//!     enabled = true
//! "#)?;
//! let app: axum::Router = axum::Router::new()
//!     .merge(ashurbanipal_axum::router(
//!         config,
//!         vec![("default".to_string(), ashurbanipal_axum::PgPoolSource::new(pool))],
//!     ));
//! # Ok(()) }
//! ```
//!
//! Read-only, schema-validated, parameterized; disabled unless the host
//! explicitly sets `enabled = true` — this crate has no opinion on which
//! environment that should be. See `docs/design.md` for the full design.

mod routes;

#[cfg(feature = "mysql")]
pub use ashurbanipal::MySqlSource;
#[cfg(feature = "postgres")]
pub use ashurbanipal::PgPoolSource;
#[cfg(feature = "sqlite")]
pub use ashurbanipal::SqliteSource;
pub use ashurbanipal::{ColumnInfo, DbError, DbSource, QueryOpts, TableData, TableInfo};
pub use ashurbanipal::{Condition, FilterError, FilterOp, Logic};
pub use ashurbanipal::{Config, ConfigError, Limits, Sibling};
pub use routes::router;
