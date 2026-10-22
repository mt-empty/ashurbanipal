//! `GET {mount}/api/siblings` (`spec/protocol.md` §5.6). Adapters only route
//! to [`SiblingChecker::check`] and serialize what it returns.

use std::time::Duration;

use futures_util::future::join_all;
use serde::Serialize;

use crate::config::{Config, Instance, SiblingsView};

#[derive(Debug, Serialize)]
pub struct SiblingsResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<Instance>,
    pub siblings: Vec<SiblingStatus>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SiblingStatus {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub base_url: String,
    pub healthy: bool,
}

/// Built once, at router construction.
pub struct SiblingChecker {
    view: SiblingsView,
    http: reqwest::Client,
}

impl SiblingChecker {
    pub fn new(config: &Config) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("reqwest client construction only fails on TLS backend misconfiguration");
        Self {
            view: config.siblings_view(),
            http,
        }
    }

    /// Checks run concurrently on the calling task rather than spawned, so
    /// this works on whichever runtime the adapter's framework uses.
    pub async fn check(&self) -> SiblingsResponse {
        let checks = self.view.siblings.iter().map(|sibling| async move {
            let healthy = self.view.is_instance(sibling)
                || match health_url(&sibling.base_url, &sibling.health_path) {
                    Some(url) => matches!(
                        self.http.get(url).send().await,
                        Ok(resp) if resp.status().is_success()
                    ),
                    None => false,
                };
            SiblingStatus {
                name: sibling.name.clone(),
                label: sibling.label.clone(),
                base_url: sibling.base_url.clone(),
                healthy,
            }
        });
        SiblingsResponse {
            instance: self.view.instance.clone(),
            siblings: join_all(checks).await,
            warnings: self.view.warnings.clone(),
        }
    }
}

/// Resolves against the sibling's origin, not its path.
fn health_url(base_url: &str, health_path: &str) -> Option<String> {
    let scheme_end = base_url.find("://")? + 3;
    let host_end = base_url[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(base_url.len());
    Some(format!("{}{}", &base_url[..host_end], health_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_url_resolves_against_origin() {
        assert_eq!(
            health_url("https://billing.internal.vpn/__ashurbanipal", "/health"),
            Some("https://billing.internal.vpn/health".to_string())
        );
        assert_eq!(
            health_url("http://localhost:4001/__ashurbanipal", "/healthz"),
            Some("http://localhost:4001/healthz".to_string())
        );
        assert_eq!(health_url("not-a-url", "/health"), None);
    }
}
