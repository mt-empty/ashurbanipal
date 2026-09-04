//! True black-box test harness: talks to an implementation only over real
//! HTTP. This file must never `use ashurbanipal_axum::...` — the whole point is
//! that this suite (and every test file in `conformance/runner`) is
//! rewritable in any language with no loss; it's the mechanism a Spring
//! Boot/Go/Elixir port's own CI runs unmodified against its own server.
//!
//! Two ways to run, selected once per test binary process
//! (`ASHURBANIPAL_CONFORMANCE_URL` env var):
//! - **Spawned** (default): builds and spawns `examples/demo.rs` per test,
//!   against `DATABASE_URL`. Today's behavior.
//! - **External**: `ASHURBANIPAL_CONFORMANCE_URL` names the target's mount
//!   root directly (e.g. `http://localhost:4000/__ashurbanipal`) — no
//!   build/spawn at all. This is the path a port's CI dogfoods.
//!
//! Every test passes `TestServer::url()` a *mount-relative* path
//! (`"/api/tables"`, or `""` for the UI route) — never a hardcoded
//! `/__ashurbanipal` prefix — since `{mount}` is implementation-defined
//! (`spec/protocol.md` §3) and the external path must work regardless of
//! what a port chooses to mount at.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::OnceCell;

const SEED_VERSION: &str = include_str!("../seed/VERSION");

fn demo_binary_path() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        escargot::CargoBuild::new()
            .example("demo")
            .run()
            .expect("failed to build the `demo` example")
            .path()
            .to_path_buf()
    })
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind an ephemeral port");
    listener.local_addr().unwrap().port()
}

enum Target {
    Spawned { child: Child, mount_root: String },
    External { mount_root: String },
}

pub struct TestServer {
    target: Target,
    http: reqwest::Client,
}

/// Runs exactly once per test binary process, regardless of how many
/// `TestServer::spawn()` calls happen across every test file — reseeding
/// (drop-and-recreate) on every one of the suite's many parallel tests
/// would both be enormously wasteful (the seed inserts 40k+ rows) and race
/// every other test reading the schema mid-drop. Whichever test's
/// `TestServer` first becomes ready lends its URL to the one-time check;
/// every later caller just awaits the cached result.
static SEED_READY: OnceCell<()> = OnceCell::const_new();

impl TestServer {
    /// Produces a ready `TestServer` — spawned or external, see module docs
    /// — and ensures the target's data is this seed (applying it, or
    /// verifying the sentinel) before returning.
    pub async fn spawn() -> Self {
        let http = reqwest::Client::new();

        let target = match std::env::var("ASHURBANIPAL_CONFORMANCE_URL") {
            Ok(url) => Target::External {
                mount_root: url.trim_end_matches('/').to_string(),
            },
            Err(_) => Self::spawn_demo(&http).await,
        };

        let mount_root = target.mount_root().to_string();
        SEED_READY
            .get_or_init(|| async { ensure_seed(&http, &mount_root).await })
            .await;

        TestServer { target, http }
    }

    async fn spawn_demo(http: &reqwest::Client) -> Target {
        let port = free_port();
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set (the devcontainer sets it automatically)");

        let mut child = Command::new(demo_binary_path())
            .env("PORT", port.to_string())
            .env("DATABASE_URL", database_url)
            .env_remove("SIBLING_PORT")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn the `demo` example binary");

        let base_url = format!("http://127.0.0.1:{port}");

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(resp) = http.get(format!("{base_url}/health")).send().await {
                if resp.status().is_success() {
                    break;
                }
            }
            if let Some(status) = child.try_wait().expect("failed to poll child status") {
                let output = child
                    .wait_with_output()
                    .expect("failed to collect child output");
                panic!(
                    "demo server exited early with {status}\nstdout:\n{}\nstderr:\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                );
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("demo server did not become ready on {base_url} within 10s");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // The Rust implementation's own mount point; an implementation under
        // the external path supplies its own root directly via
        // ASHURBANIPAL_CONFORMANCE_URL.
        Target::Spawned {
            child,
            mount_root: format!("{base_url}/__ashurbanipal"),
        }
    }

    /// `path` is mount-relative: `"/api/tables"`, or `""` for the UI route.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.target.mount_root(), path)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.http
    }
}

impl Target {
    fn mount_root(&self) -> &str {
        match self {
            Target::Spawned { mount_root, .. } => mount_root,
            Target::External { mount_root } => mount_root,
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Target::Spawned { child, .. } = &mut self.target {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// If `ASHURBANIPAL_CONFORMANCE_SEED_DSN` is set, applies
/// `conformance/seed/seed.sql` directly (idempotent — drops and recreates
/// its own tables). Either way, then reads the `_conformance_meta` sentinel
/// back over the ordinary protocol — an unprivileged base table, so
/// `GET /api/tables/data?table=_conformance_meta` works identically for a
/// spawned reference and an external port with no separate DB credential —
/// to confirm the seed version and record the SQL dialect it declares
/// (`crate::backend`).
async fn ensure_seed(http: &reqwest::Client, mount_root: &str) {
    if let Ok(dsn) = std::env::var("ASHURBANIPAL_CONFORMANCE_SEED_DSN") {
        apply_seed(&dsn);
    }
    verify_seed_sentinel(http, mount_root).await;
}

/// Postgres only (`psql` + `seed.sql`). For a MySQL/SQLite target, apply
/// `seed.mysql.sql` / `seed.sqlite.sql` out of band and let the sentinel
/// path below take over — see `rust-axum-conformance.yml`.
fn apply_seed(dsn: &str) {
    let seed_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("conformance/seed/seed.sql");
    let status = Command::new("psql")
        .arg(dsn)
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("-f")
        .arg(&seed_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("failed to run `psql` to apply conformance/seed/seed.sql (is it installed?)");
    if !status.status.success() {
        panic!(
            "applying {} via ASHURBANIPAL_CONFORMANCE_SEED_DSN failed:\nstdout:\n{}\nstderr:\n{}",
            seed_path.display(),
            String::from_utf8_lossy(&status.stdout),
            String::from_utf8_lossy(&status.stderr),
        );
    }
}

async fn verify_seed_sentinel(http: &reqwest::Client, mount_root: &str) {
    let url = format!("{mount_root}/api/tables/data?table=_conformance_meta&limit=1");
    let resp = http.get(&url).send().await.unwrap_or_else(|e| {
        panic!("could not reach the conformance target at {mount_root} to verify its seed: {e}")
    });
    if !resp.status().is_success() {
        panic!(
            "conformance target at {mount_root} has no `_conformance_meta` table (status {}) \
             — it isn't running conformance/seed/seed.sql. Either apply the seed yourself \
             (conformance/seed/README.md) or set ASHURBANIPAL_CONFORMANCE_SEED_DSN so the \
             runner applies it for you.",
            resp.status()
        );
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .expect("_conformance_meta response wasn't valid JSON");
    let seed_version = body["rows"][0]["seed_version"]
        .as_str()
        .unwrap_or_else(|| panic!("_conformance_meta row is missing `seed_version`: {body}"));
    let expected = SEED_VERSION.trim();
    if seed_version != expected {
        panic!(
            "conformance target at {mount_root} is running seed_version {seed_version:?}, \
             expected {expected:?} (conformance/seed/VERSION) — its seed is stale. Reapply \
             conformance/seed/seed.sql."
        );
    }

    // `dialect` (added in seed_version 4) tells the backend-aware
    // assertions which engine's expectations to hold. A seed without it
    // leaves `ASHURBANIPAL_CONFORMANCE_BACKEND` (or the Postgres default)
    // in play; if both are set they must resolve to the same engine.
    use crate::backend::Backend;
    if let Some(dialect) = body["rows"][0]["dialect"].as_str() {
        if let Ok(env_backend) = std::env::var("ASHURBANIPAL_CONFORMANCE_BACKEND") {
            if let (Some(from_env), Some(from_seed)) =
                (Backend::parse(&env_backend), Backend::parse(dialect))
            {
                assert_eq!(
                    from_env, from_seed,
                    "ASHURBANIPAL_CONFORMANCE_BACKEND={env_backend:?} disagrees with the loaded \
                     seed's dialect {dialect:?} — the target isn't seeded with what the env var claims"
                );
            }
        }
        Backend::record_from_seed(dialect);
    }
    Backend::mark_seed_checked();
}
