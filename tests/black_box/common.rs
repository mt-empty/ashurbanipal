//! True black-box test harness: spawns the actual `demo` example binary as a
//! separate OS process and talks to it only over real HTTP. This file must
//! never `use ashurbanipal::...` — the whole point is that these tests would
//! be rewritable in any language with no loss.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

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

pub struct TestServer {
    child: Child,
    base_url: String,
    http: reqwest::Client,
}

impl TestServer {
    /// Spawns a fresh `demo` server process on an OS-assigned port and
    /// blocks until it answers `/health`, or panics with the child's
    /// captured output if it never comes up.
    pub async fn spawn() -> Self {
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
        let http = reqwest::Client::new();

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

        TestServer {
            child,
            base_url,
            http,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.http
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
