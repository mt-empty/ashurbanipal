use crate::assert::{assert_exact, assert_row_estimate, assert_status};
use crate::common::TestServer;

pub(crate) const SEEDED_TABLES: [&str; 14] = [
    "_conformance_meta",
    "audit_log",
    "events",
    "feature_flags",
    "inventory_counts",
    "inventory_locations",
    "orders",
    "payments",
    "products",
    "reviews",
    "saved_reports",
    "sessions",
    "support_tickets",
    "users",
];

#[tokio::test]
async fn lists_exactly_the_seeded_tables_in_alphabetical_order() {
    let srv = TestServer::spawn().await;
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
    assert_exact(names, SEEDED_TABLES.to_vec(), "GET /api/tables names");
}

#[tokio::test]
async fn table_comments_are_present_only_where_seeded() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let by_name = |n: &str| -> &serde_json::Value {
        body["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == n)
            .unwrap()
    };

    for commented in [
        "users",
        "orders",
        "sessions",
        "reviews",
        "support_tickets",
        "_conformance_meta",
    ] {
        assert!(
            by_name(commented)["comment"].is_string(),
            "{commented} should have a string comment"
        );
    }
    for uncommented in [
        "products",
        "events",
        "payments",
        "audit_log",
        "saved_reports",
        "inventory_locations",
        "inventory_counts",
        "feature_flags",
    ] {
        assert!(
            !by_name(uncommented)
                .as_object()
                .unwrap()
                .contains_key("comment"),
            "{uncommented} should have no `comment` key at all"
        );
    }
}

#[tokio::test]
async fn table_counts_cover_all_seeded_tables_with_approx_rows() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/table-counts"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let counts = body["counts"].as_array().unwrap();
    assert_exact(counts.len(), SEEDED_TABLES.len(), "counts entry count");

    let mut names: Vec<&str> = counts
        .iter()
        .map(|c| c["table"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    let mut expected = SEEDED_TABLES.to_vec();
    expected.sort_unstable();
    assert_exact(names, expected, "counts table names");

    for entry in counts {
        assert_row_estimate(&entry["approx_rows"], &format!("table-counts[{entry}]"));
    }

    // feature_flags is deliberately never ANALYZEd (conformance/seed/README.md)
    // — the §5.3 case for reltuples reading back -1.
    let feature_flags = counts
        .iter()
        .find(|c| c["table"] == "feature_flags")
        .unwrap();
    assert_exact(
        feature_flags["approx_rows"].as_i64().unwrap(),
        -1,
        "feature_flags.approx_rows (never analyzed)",
    );
}

/// spec/protocol.md §6: every catalog and data query MUST be scoped to
/// `current_schema()`, never every schema on the connection.
/// `other_schema.decoy_items` (conformance/seed/README.md) exists
/// specifically so this is falsifiable.
#[tokio::test]
async fn schema_scoping_excludes_other_schemas() {
    let srv = TestServer::spawn().await;
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
    assert!(
        !names.contains(&"decoy_items"),
        "a table from another schema leaked into /api/tables: {names:?}"
    );

    let resp = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "decoy_items")])
        .send()
        .await
        .unwrap();
    assert_status(
        &resp,
        400,
        "table=decoy_items (a real table, but in a different schema)",
    );
}
