//! `spec/protocol.md` §5.6 — `instance`, sibling `label`, and the sibling that
//! is this instance reported in place without a health check. Every test
//! self-skips unless the target reports an `instance`, so this file runs
//! safely alongside `html_and_siblings.rs`. CI starts each port's demo with
//! `CONFORMANCE_LABELLED_SIBLINGS=1` (Spring: profile
//! `conformance-labelled-siblings`), which every port maps to the same fixed
//! configuration:
//!
//! - instance `conformance` / `a`
//! - siblings, in order: `conformance`/`a` (this instance), `conformance`/`b`,
//!   `other`/`a` twice (a deliberate duplicate), all at
//!   `http://127.0.0.1:9/__ashurbanipal` (port 9 refuses at once, so every
//!   check made is a fast `healthy: false`)

use crate::assert::assert_exact;
use crate::common::TestServer;

const UNREACHABLE: &str = "http://127.0.0.1:9/__ashurbanipal";

/// `None` when the target has no `instance` configured — every test below
/// uses this to skip itself rather than fail.
async fn labelled_siblings(srv: &TestServer) -> Option<serde_json::Value> {
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/siblings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    if body.get("instance").is_none_or(|v| v.is_null()) {
        eprintln!(
            "labelled_siblings: skipping — target reports no instance \
             (start it with CONFORMANCE_LABELLED_SIBLINGS=1 to exercise this file)"
        );
        return None;
    }
    Some(body)
}

#[tokio::test]
async fn instance_is_echoed_as_configured() {
    let srv = TestServer::spawn().await;
    let Some(body) = labelled_siblings(&srv).await else {
        return;
    };
    assert_exact(
        body["instance"].clone(),
        serde_json::json!({ "name": "conformance", "label": "a" }),
        "GET /api/siblings instance",
    );
}

/// Its base_url refuses connections, so `healthy: true` can only mean the
/// target never health-checked it.
#[tokio::test]
async fn this_instance_is_listed_healthy_without_a_check() {
    let srv = TestServer::spawn().await;
    let Some(body) = labelled_siblings(&srv).await else {
        return;
    };
    assert_exact(
        body["siblings"][0].clone(),
        serde_json::json!({ "name": "conformance", "label": "a", "base_url": UNREACHABLE, "healthy": true }),
        "GET /api/siblings own entry",
    );
}

#[tokio::test]
async fn labels_are_echoed_in_configuration_order() {
    let srv = TestServer::spawn().await;
    let Some(body) = labelled_siblings(&srv).await else {
        return;
    };
    assert_exact(
        body["siblings"].clone(),
        serde_json::json!([
            { "name": "conformance", "label": "a", "base_url": UNREACHABLE, "healthy": true },
            { "name": "conformance", "label": "b", "base_url": UNREACHABLE, "healthy": false },
            { "name": "other", "label": "a", "base_url": UNREACHABLE, "healthy": false },
            { "name": "other", "label": "a", "base_url": UNREACHABLE, "healthy": false },
        ]),
        "GET /api/siblings siblings",
    );
}

/// Wording is implementation-defined, so only the count and type are checked.
#[tokio::test]
async fn a_duplicate_is_kept_and_warned_once() {
    let srv = TestServer::spawn().await;
    let Some(body) = labelled_siblings(&srv).await else {
        return;
    };
    let warnings = body["warnings"]
        .as_array()
        .unwrap_or_else(|| panic!("GET /api/siblings: expected a warnings array, got {body}"));
    assert_eq!(
        warnings.len(),
        1,
        "GET /api/siblings warnings: {warnings:?}"
    );
    assert!(
        warnings[0].as_str().is_some_and(|w| !w.is_empty()),
        "GET /api/siblings warnings: {warnings:?}"
    );
}
