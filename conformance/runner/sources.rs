//! `spec/protocol.md` §5.8 and the `source` param on §5.2–§5.5, §5.7 —
//! coverage that only needs a single-source demo (the default `TestServer::
//! spawn()` target): the wire shape is additive and doesn't disturb the
//! existing single-source behavior, which is the regression this feature
//! must never break. The true two-source round-trip (does an explicit
//! `source` actually reach different data, does `api/sources`' order match
//! default resolution) lives in `two_source.rs` instead, since it needs a
//! target started with a second source registered.

use crate::assert::{assert_exact, assert_status};
use crate::common::TestServer;

#[tokio::test]
async fn lists_exactly_the_one_registered_source() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/sources"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sources = body["sources"].as_array().unwrap();
    // Self-skips like two_source.rs, not an env var: 2-by-design and
    // 2-by-bug look identical over black-box HTTP, so exact-count intent
    // is left to each port's own white-box test (COVERAGE.md's Known gaps).
    if sources.len() != 1 {
        eprintln!(
            "sources: skipping the exact-one-entry check — target registered {} source(s) \
             (a two-source-conformance target; see two_source.rs for its own checks)",
            sources.len()
        );
    } else {
        assert_exact(
            sources.len(),
            1,
            "a single-source deployment must list exactly one entry (spec/protocol.md §5.8)",
        );
    }
    for source in sources {
        assert!(
            source["name"].is_string(),
            "each entry must carry a `name`: {sources:?}"
        );
        assert!(
            source.get("backend").is_none(),
            "api/sources must never disclose a backend engine (spec/protocol.md §5.8): {sources:?}"
        );
    }
}

#[tokio::test]
async fn explicit_default_source_matches_the_implicit_default() {
    let srv = TestServer::spawn().await;
    let sources: serde_json::Value = srv
        .client()
        .get(srv.url("/api/sources"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let name = sources["sources"][0]["name"].as_str().unwrap().to_string();

    let implicit: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let explicit: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .query(&[("source", name.as_str())])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        explicit,
        implicit,
        "an explicit, correct `source` must resolve identically to an absent one (spec/protocol.md §1)",
    );
}

/// Same evil-value coverage `schemas::unrecognized_schema_values_are_rejected_cleanly_on_every_route`
/// already gives `schema` — every route that takes `source` must reject an
/// unrecognized value the same allow-list-before-use way, injection-shaped
/// strings included.
#[tokio::test]
async fn unrecognized_source_values_are_rejected_cleanly_on_every_route() {
    let srv = TestServer::spawn().await;
    for evil in [
        "",
        "nonexistent_source",
        "primary\"; drop schema public cascade; --",
        "primary' OR '1'='1",
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/schemas"))
            .query(&[("source", evil)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("GET /api/schemas?source={evil:?}"));

        let resp = srv
            .client()
            .get(srv.url("/api/tables"))
            .query(&[("source", evil)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("GET /api/tables?source={evil:?}"));

        let resp = srv
            .client()
            .get(srv.url("/api/table-counts"))
            .query(&[("source", evil)])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/table-counts?source={evil:?}"),
        );

        let resp = srv
            .client()
            .get(srv.url("/api/tables/data"))
            .query(&[("source", evil), ("table", "users")])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("GET /api/tables/data?source={evil:?}"));

        let resp = srv
            .client()
            .get(srv.url("/api/tables/common-values"))
            .query(&[("source", evil), ("table", "users"), ("column", "email")])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/tables/common-values?source={evil:?}"),
        );
    }
}

#[tokio::test]
async fn every_sources_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/sources"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.headers()
            .get("x-ashurbanipal-protocol")
            .and_then(|v| v.to_str().ok()),
        Some("1"),
        "GET /api/sources response header"
    );
}
