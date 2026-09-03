//! Shared helpers for the `mysql`-feature integration tests. Both of them
//! talk to the one long-lived devcontainer MySQL, so a throwaway database
//! or user left behind by a panicked assertion pollutes later files'
//! `/api/schemas` assertions (and the conformance suite) until the leaking
//! test is re-run. This module is only ever compiled into a test binary
//! built with `--features mysql`.

use sqlx::mysql::MySqlPoolOptions;
use sqlx::Executor;

/// Runs `statements` (each one SQL statement — a `drop database …`, a
/// `drop user …`, an optional leading `set foreign_key_checks = 0`) when
/// the value is dropped, panic unwinds included. `Drop` is sync and may
/// run while the test's own Tokio runtime is still the ambient one, so the
/// work goes on a throwaway current-thread runtime on its own thread; the
/// `join()` keeps `cargo test` from exiting before the drops land.
pub struct MysqlCleanup {
    pub url: String,
    pub statements: Vec<String>,
}

impl Drop for MysqlCleanup {
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
                let Ok(pool) = MySqlPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                else {
                    return;
                };
                for stmt in statements {
                    let _ = pool.execute(sqlx::AssertSqlSafe(stmt)).await;
                }
            });
        })
        .join();
    }
}
