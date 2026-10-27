//! Framework-agnostic core for Ashurbanipal — config/kill-switch, `DbSource`
//! backends, filter-DSL validation, sibling health checks and the routes'
//! request/response shapes, with no HTTP framework dependency.
//! `ashurbanipal-axum` (and any future framework adapter) re-exports this
//! crate's public API unchanged; see `docs/design.md` for the full design.

pub mod config;
pub mod db;
pub mod filter;
pub mod join;
pub mod protocol_wire;
pub mod siblings;

pub use config::{Config, ConfigError, Instance, Limits, Sibling, SiblingsView};
#[cfg(feature = "mysql")]
pub use db::MySqlSource;
#[cfg(feature = "postgres")]
pub use db::PgPoolSource;
#[cfg(feature = "sqlite")]
pub use db::SqliteSource;
pub use db::{
    default_source, resolve_source, ColumnInfo, ColumnPair, ConstraintCheck, ConstraintFk,
    ConstraintPk, ConstraintUnique, Constraints, DbError, DbSource, IndexInfo, NotAllowedDetail,
    NotAllowedKind, ProblemDetails, QueryOpts, ReferencedBy, SchemaListing, Structure, TableData,
    TableInfo,
};
pub use filter::{Condition, FilterError, FilterOp, Logic};
pub use join::{JoinColumnInfo, JoinData, JoinError, JoinOpts, JoinSpec};
pub use siblings::{SiblingChecker, SiblingStatus, SiblingsResponse};

#[cfg(not(any(feature = "postgres", feature = "sqlite", feature = "mysql")))]
compile_error!(
    "ashurbanipal: enable at least one of the `postgres`, `sqlite`, or `mysql` features"
);
