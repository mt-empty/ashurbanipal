//! Ashurbanipal — Actix-web adapter. Framework-agnostic config, `DbSource`
//! backends, and the filter DSL live in the `ashurbanipal` core crate and
//! are re-exported here unchanged; this crate only adds the Actix-web
//! router/handler layer. See `ashurbanipal-axum` for the reference (Axum)
//! adapter and `docs/design.md` for the full design.
//!
//! ```no_run
//! # async fn example(pool: sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
//! use actix_web::{App, HttpServer};
//!
//! let config = ashurbanipal_actix_web::Config::from_toml(r#"
//!     environment = "dev"
//!     enabled_for = ["dev", "integration"]
//! "#)?;
//! let state = ashurbanipal_actix_web::app_state(config, ashurbanipal_actix_web::PgPoolSource::new(pool));
//! HttpServer::new(move || App::new().service(ashurbanipal_actix_web::service(state.clone())))
//!     .bind(("0.0.0.0", 4000))?
//!     .run()
//!     .await?;
//! # Ok(()) }
//! ```

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
pub use routes::{app_state, service, AppState};
