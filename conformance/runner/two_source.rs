//! `spec/protocol.md` §1/§5.8 — the true two-source round-trip a
//! single-source demo can't reach. Every test here self-skips against a
//! target with only one registered source, so this file runs safely
//! alongside `sources.rs` unconditionally; it never checks *how* a target
//! got a second source (each port wires that its own way), only that
//! `api/sources` says >= 2.
//!
//! The second source is deliberately *not* a second database: it's the
//! same connection, pinned to `other_schema` (already seeded with one
//! table, `decoy_items`), trading genuinely separate storage for zero new
//! CI infrastructure — see `docs/feature-backlog/19-two-source-conformance-round-trip.md`.
//! A port is free to name its second source anything; this file discovers
//! the name from `api/sources` rather than assuming one.

use crate::assert::assert_exact;
use crate::common::TestServer;

/// `None` when the target wasn't started with a second source — every
/// test below uses this to skip itself rather than fail. Returns the whole
/// `api/sources` body, so a caller needing `default` too doesn't issue its
/// own separate request.
async fn sources_if_two_or_more(srv: &TestServer) -> Option<serde_json::Value> {
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
    if sources.len() < 2 {
        eprintln!(
            "two_source: skipping — target registered {} source(s), need >= 2 \
             (start it with CONFORMANCE_SECOND_SOURCE=1 to exercise this file)",
            sources.len()
        );
        return None;
    }
    Some(body)
}

/// The pinned second source's name. `.last()`, not `[1]`: a local run
/// stacking SECOND_SOURCE and CONFORMANCE_SECOND_SOURCE together registers
/// 3 sources, pushing this one to `[2]`.
fn second_source_name(body: &serde_json::Value) -> &str {
    body["sources"].as_array().unwrap().last().unwrap()["name"]
        .as_str()
        .unwrap()
}

/// `source: None` omits the query param entirely (the default-resolution
/// path), never an empty string (which is itself a rejected value).
async fn fetch_tables(srv: &TestServer, source: Option<&str>) -> serde_json::Value {
    let mut req = srv.client().get(srv.url("/api/tables"));
    if let Some(source) = source {
        req = req.query(&[("source", source)]);
    }
    req.send().await.unwrap().json().await.unwrap()
}

async fn table_names(srv: &TestServer, source: Option<&str>) -> Vec<String> {
    fetch_tables(srv, source).await["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn second_source_is_scoped_to_other_schema_and_differs_from_the_default() {
    let srv = TestServer::spawn().await;
    let Some(body) = sources_if_two_or_more(&srv).await else {
        return;
    };
    let second = second_source_name(&body);

    let (default_tables, second_tables) =
        tokio::join!(table_names(&srv, None), table_names(&srv, Some(second)));

    assert_exact(
        second_tables,
        vec!["decoy_items".to_string()],
        "the second source must be pinned to other_schema, which seeds exactly one table (spec/protocol.md §1)",
    );
    assert!(
        !default_tables.contains(&"decoy_items".to_string()),
        "the default source must never expose other_schema's table (spec/protocol.md §1): {default_tables:?}"
    );
}

#[tokio::test]
async fn api_sources_default_matches_default_resolution() {
    let srv = TestServer::spawn().await;
    let Some(body) = sources_if_two_or_more(&srv).await else {
        return;
    };
    let default = body["default"].as_str().unwrap();

    let (default_tables, explicit_default_tables) =
        tokio::join!(fetch_tables(&srv, None), fetch_tables(&srv, Some(default)));
    assert_exact(
        explicit_default_tables,
        default_tables,
        "api/sources' `default` must be the source an absent `source` param resolves to (spec/protocol.md §1, §5.8)",
    );
}

#[tokio::test]
async fn second_source_reports_its_pinned_schema_as_default() {
    let srv = TestServer::spawn().await;
    let Some(body) = sources_if_two_or_more(&srv).await else {
        return;
    };
    let second = second_source_name(&body);
    let schemas: serde_json::Value = srv
        .client()
        .get(srv.url("/api/schemas"))
        .query(&[("source", second)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        schemas["default"].as_str(),
        Some("other_schema"),
        "a source pinned to other_schema must report it as its default schema (spec/protocol.md §5.7)",
    );
}
