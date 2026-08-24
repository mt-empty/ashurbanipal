//! `spec/protocol.md` §1/§5.8 — the true two-source round-trip
//! `sources.rs` can't reach with a single-source demo (see its own module
//! doc and `COVERAGE.md`'s former Known gaps entry). Every test here
//! self-skips (prints a message, returns) against a demo that only
//! registers one source, so this file runs safely as part of the same
//! unconditional suite `sources.rs` lives in — it only asserts anything
//! when the target was actually started in two-source mode
//! (`CONFORMANCE_SECOND_SOURCE=1`, one env var every port's own demo
//! entrypoint understands the same way).
//!
//! The second source is deliberately *not* a second database: it's the
//! same connection, pinned to `other_schema` — already part of
//! `conformance/seed/seed.sql` (`other_schema.decoy_items`, one table),
//! so this needs zero new CI infrastructure. That trades off proving
//! genuinely separate storage for proving genuine per-request dispatch —
//! see `docs/feature-backlog/19-two-source-conformance-round-trip.md`'s
//! "Constraints / open questions" for why that tradeoff was chosen. A
//! port is free to name its second source anything; this file discovers
//! the name from `api/sources` rather than assuming one.

use crate::assert::assert_exact;
use crate::common::TestServer;

/// `None` (with an explanatory message) when the target wasn't started
/// with a second source — the signal every test below uses to skip
/// itself rather than fail.
async fn second_source_name(srv: &TestServer) -> Option<String> {
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
    Some(sources[1]["name"].as_str().unwrap().to_string())
}

/// `source: None` omits the query param entirely (the default-resolution
/// path), never an empty string (which is itself a rejected value).
async fn table_names(srv: &TestServer, source: Option<&str>) -> Vec<String> {
    let mut req = srv.client().get(srv.url("/api/tables"));
    if let Some(source) = source {
        req = req.query(&[("source", source)]);
    }
    let body: serde_json::Value = req.send().await.unwrap().json().await.unwrap();
    body["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn second_source_is_scoped_to_other_schema_and_differs_from_the_default() {
    let srv = TestServer::spawn().await;
    let Some(second) = second_source_name(&srv).await else {
        return;
    };

    let default_tables = table_names(&srv, None).await;
    let second_tables = table_names(&srv, Some(&second)).await;

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
async fn api_sources_order_matches_default_resolution_order() {
    let srv = TestServer::spawn().await;
    let Some(_second) = second_source_name(&srv).await else {
        return;
    };

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/sources"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let first_listed = body["sources"][0]["name"].as_str().unwrap().to_string();

    let default_tables: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let explicit_first_tables: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .query(&[("source", first_listed.as_str())])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        explicit_first_tables,
        default_tables,
        "api/sources' first entry must be the same source an absent `source` param resolves to (spec/protocol.md §1, §5.8)",
    );
}
