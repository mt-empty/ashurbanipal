//! Drop guard for the Postgres-backed integration tests. They share the one
//! long-lived devcontainer database, so a schema or role left behind by a
//! failed assertion shows up in `/api/schemas` under `rust:dev` and in later
//! runs.

use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::Executor;

/// Drops `schemas` (cascade), then `roles`, when the value is dropped, panic
/// unwinds included. `Drop` is sync and may run inside the test's own Tokio
/// runtime, so the work goes on a throwaway current-thread runtime on its own
/// thread; the `join()` keeps `cargo test` from exiting before the drops land.
pub struct PgCleanup {
    url: String,
    statements: Vec<String>,
}

impl PgCleanup {
    pub fn new(url: &str, schemas: &[&str], roles: &[&str]) -> Self {
        let statements = schemas
            .iter()
            .map(|s| format!("drop schema if exists {s} cascade"))
            .chain(roles.iter().map(|r| format!("drop role if exists {r}")))
            .collect();
        Self {
            url: url.to_owned(),
            statements,
        }
    }
}

impl Drop for PgCleanup {
    fn drop(&mut self) {
        let url = std::mem::take(&mut self.url);
        let statements = std::mem::take(&mut self.statements);
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(async move {
                let pool = match PgPoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(Duration::from_secs(5))
                    .connect(&url)
                    .await
                {
                    Ok(pool) => pool,
                    Err(e) => {
                        eprintln!("PgCleanup: could not connect to drop test schemas: {e}");
                        return;
                    }
                };
                for stmt in statements {
                    if let Err(e) = pool.execute(sqlx::AssertSqlSafe(stmt)).await {
                        eprintln!("PgCleanup: teardown statement failed: {e}");
                    }
                }
            });
        })
        .join();
    }
}
