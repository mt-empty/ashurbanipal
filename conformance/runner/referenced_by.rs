//! `spec/protocol.md` §5.9 `GET /api/tables/referenced-by` — the reverse of
//! §5.4.1's per-column `references`. Verified against the seed's
//! multi-referrer `users`, composite-FK `inventory_locations`, and
//! un-referenced `feature_flags` (`conformance/seed/README.md`).

use crate::assert::{assert_exact, assert_status};
use crate::backend::{Backend, CrossSchemaReferrers};
use crate::common::TestServer;

async fn referenced_by(srv: &TestServer, table: &str) -> Vec<serde_json::Value> {
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/referenced-by"))
        .query(&[("table", table)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    body["referenced_by"].as_array().unwrap().clone()
}

/// P5.9-SHAPE: one entry per FK constraint targeting `table`; a referrer
/// with two FKs to the target appears twice; `columns` pairs are explicit.
/// Presence-based — the exact referrer set of `users` differs by dialect
/// (the hand-authored MySQL/SQLite seeds carry fewer FKs,
/// `docs/feature-backlog/35-conformance-seed-dialect-parity.md`), so this
/// never asserts the list or its length.
#[tokio::test]
async fn lists_incoming_fk_constraints_with_explicit_column_pairs() {
    let srv = TestServer::spawn().await;
    let entries = referenced_by(&srv, "users").await;

    for (ref_table, from_col) in [
        ("orders", "user_id"),
        ("support_tickets", "user_id"),
        ("support_tickets", "assigned_admin_id"),
    ] {
        let entry = entries
            .iter()
            .find(|e| {
                e["table"] == ref_table
                    && e["columns"].as_array().unwrap().len() == 1
                    && e["columns"][0]["from"] == from_col
            })
            .unwrap_or_else(|| {
                panic!("referenced_by(users) missing {ref_table}.{from_col}: {entries:#?}")
            });
        assert_exact(
            entry["columns"][0]["to"].clone(),
            serde_json::json!("id"),
            &format!("{ref_table}.{from_col} -> users.id"),
        );
        assert!(
            entry["constraint"].as_str().is_some_and(|s| !s.is_empty()),
            "{ref_table}.{from_col}: `constraint` must be a non-empty string"
        );
        assert!(
            entry.as_object().unwrap().get("schema").is_none(),
            "{ref_table}.{from_col}: a same-schema referrer must omit `schema`"
        );
    }

    // `(table, constraint)` is unique within one response.
    let keys: Vec<(&str, &str)> = entries
        .iter()
        .map(|e| {
            (
                e["table"].as_str().unwrap(),
                e["constraint"].as_str().unwrap(),
            )
        })
        .collect();
    let unique: std::collections::HashSet<_> = keys.iter().collect();
    assert_exact(
        unique.len(),
        keys.len(),
        "(table, constraint) pairs must be unique within one response",
    );
}

/// P5.9-COMPOSITE-INCLUDED: unlike §5.4.1's per-column metadata, this route
/// keeps composite FKs — one entry, `columns` carrying every pair in order.
#[tokio::test]
async fn composite_foreign_keys_are_included_with_every_column_pair() {
    let srv = TestServer::spawn().await;
    let entries = referenced_by(&srv, "inventory_locations").await;
    assert_exact(
        entries.len(),
        1,
        "inventory_locations has exactly one referrer",
    );
    let e = &entries[0];
    assert_exact(
        e["table"].clone(),
        serde_json::json!("inventory_counts"),
        "referrer table",
    );
    assert_exact(
        e["columns"].clone(),
        serde_json::json!([
            {"from": "warehouse_code", "to": "warehouse_code"},
            {"from": "bin_code", "to": "bin_code"}
        ]),
        "composite FK column pairs, in constraint order",
    );
}

/// P5.9-ZERO-REFERRERS: nothing points at `feature_flags` — `[]`, not a 404.
#[tokio::test]
async fn a_table_nothing_references_returns_an_empty_list() {
    let srv = TestServer::spawn().await;
    let entries = referenced_by(&srv, "feature_flags").await;
    assert_exact(entries, Vec::new(), "referenced_by(feature_flags)");
}

/// P5.9-CROSS-SCHEMA (Postgres): a referrer in another schema is reported
/// with a `schema` field. MySQL scopes to the resolved database and SQLite
/// has one schema, so both self-skip.
#[tokio::test]
async fn cross_schema_referrers_carry_a_schema_field() {
    let srv = TestServer::spawn().await;
    if let CrossSchemaReferrers::ScopedToResolvedSchema =
        Backend::current().cross_schema_referrers()
    {
        eprintln!(
            "referenced_by: skipping cross-schema check — this backend scopes referrers to the resolved schema"
        );
        return;
    }
    let entries = referenced_by(&srv, "users").await;
    let e = entries
        .iter()
        .find(|e| e["table"] == "shipment_events")
        .unwrap_or_else(|| {
            panic!(
                "referenced_by(users) missing cross-schema warehouse.shipment_events: {entries:#?}"
            )
        });
    assert_exact(
        e["schema"].clone(),
        serde_json::json!("warehouse"),
        "cross-schema referrer schema",
    );
    assert_exact(
        e["columns"][0].clone(),
        serde_json::json!({"from": "handled_by_user_id", "to": "id"}),
        "cross-schema referrer column pair",
    );
}

/// P5.9-TABLE-EXACT-MATCH: `table` must match §5.2 exactly; anything else,
/// including injection-shaped input, is a clean 400 that never reaches SQL.
#[tokio::test]
async fn unknown_or_malicious_table_values_are_rejected_cleanly() {
    let srv = TestServer::spawn().await;
    for evil in [
        "",
        "no_such_table",
        "users\"; drop table users; --",
        "users' OR '1'='1",
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/referenced-by"))
            .query(&[("table", evil)])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/tables/referenced-by?table={evil:?}"),
        );
    }
    // `table` is required.
    let resp = srv
        .client()
        .get(srv.url("/api/tables/referenced-by"))
        .send()
        .await
        .unwrap();
    assert_status(
        &resp,
        400,
        "GET /api/tables/referenced-by with no `table` param",
    );
}

/// P5.9-SCHEMA-PARAM: an explicit default `schema` resolves identically to
/// an absent one; an unknown `schema` is a 400.
#[tokio::test]
async fn schema_param_resolves_like_the_other_routes() {
    let srv = TestServer::spawn().await;
    let default_schema = Backend::current().default_schema();

    let implicit = referenced_by(&srv, "users").await;
    let explicit: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/referenced-by"))
        .query(&[("table", "users"), ("schema", default_schema.as_str())])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        explicit["referenced_by"].as_array().unwrap().clone(),
        implicit,
        "explicit default schema resolves like an absent one",
    );

    let resp = srv
        .client()
        .get(srv.url("/api/tables/referenced-by"))
        .query(&[("table", "users"), ("schema", "no_such_schema")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "referenced-by with an unknown schema");
}

/// P5.9-SOURCE-PARAM: an unknown `source` is a 400.
#[tokio::test]
async fn unknown_source_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/referenced-by"))
        .query(&[("table", "users"), ("source", "no_such_source")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "referenced-by with an unknown source");
}

/// P5.9-HEADER: the protocol version header rides every response, 200 or 400.
#[tokio::test]
async fn every_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    for (query, label) in [
        (vec![("table", "users")], "200"),
        (vec![("table", "nope")], "400"),
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/referenced-by"))
            .query(&query)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.headers()
                .get("x-ashurbanipal-protocol")
                .and_then(|v| v.to_str().ok()),
            Some("1"),
            "referenced-by {label} response header"
        );
    }
}
