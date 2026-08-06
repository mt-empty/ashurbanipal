//! `spec/protocol.md` §5.7 and the `schema` param on §5.2–§5.5 — verified
//! against `other_schema.decoy_items`, the seed's dedicated fixture for
//! exactly this (`conformance/seed/README.md`).

use crate::assert::{assert_exact, assert_status};
use crate::common::TestServer;
use crate::tables::SEEDED_TABLES;

#[tokio::test]
async fn lists_public_and_the_seed_s_second_schema_excluding_system_namespaces() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/schemas"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = body["schemas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"public") && names.contains(&"other_schema"),
        "GET /api/schemas must list both seeded schemas: {names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|n| *n == "pg_catalog" || *n == "information_schema" || n.starts_with("pg_")),
        "GET /api/schemas must never list system/internal namespaces: {names:?}"
    );
}

#[tokio::test]
async fn explicit_schema_public_matches_the_implicit_default() {
    let srv = TestServer::spawn().await;
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
        .query(&[("schema", "public")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        explicit,
        implicit,
        "schema=public must resolve identically to an absent schema param (spec/protocol.md §1)",
    );
}

#[tokio::test]
async fn explicit_other_schema_selects_only_its_own_table() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .query(&[("schema", "other_schema")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = body["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_exact(
        names,
        vec!["decoy_items"],
        "GET /api/tables?schema=other_schema",
    );

    let data: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("schema", "other_schema"), ("table", "decoy_items")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        data["rows"].as_array().unwrap().len(),
        2,
        "other_schema.decoy_items row count",
    );
}

/// Every route that takes `schema` must reject an unrecognized value the
/// same way `table`/`column` already do — including injection-shaped
/// strings, which must 400 as "just another unknown name", never reach SQL
/// text (same class of coverage as
/// `table_data::malicious_table_values_are_rejected_cleanly_and_do_no_damage`).
#[tokio::test]
async fn unrecognized_schema_values_are_rejected_cleanly_on_every_route() {
    let srv = TestServer::spawn().await;
    for evil in [
        "",
        "nonexistent_schema",
        "public\"; drop schema public cascade; --",
        "public' OR '1'='1",
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables"))
            .query(&[("schema", evil)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("GET /api/tables?schema={evil:?}"));

        let resp = srv
            .client()
            .get(srv.url("/api/table-counts"))
            .query(&[("schema", evil)])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/table-counts?schema={evil:?}"),
        );

        let resp = srv
            .client()
            .get(srv.url("/api/tables/data"))
            .query(&[("schema", evil), ("table", "users")])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("GET /api/tables/data?schema={evil:?}"));

        let resp = srv
            .client()
            .get(srv.url("/api/tables/common-values"))
            .query(&[("schema", evil), ("table", "users"), ("column", "email")])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/tables/common-values?schema={evil:?}"),
        );
    }

    // Confirm no damage: the default view is unaffected by the attempts above.
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = body["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_exact(
        names,
        SEEDED_TABLES.to_vec(),
        "table list after injection attempts",
    );
}

#[tokio::test]
async fn every_schemas_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/schemas"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.headers()
            .get("x-ashurbanipal-protocol")
            .and_then(|v| v.to_str().ok()),
        Some("1"),
        "GET /api/schemas response header"
    );
}
