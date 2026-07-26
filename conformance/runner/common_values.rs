use crate::assert::{assert_freq, assert_status};
use crate::common::TestServer;

#[tokio::test]
async fn returns_value_freq_pairs_with_booleans_as_text_not_pg_array_literals() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "is_active")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let values = body["values"].as_array().unwrap();
    assert!(!values.is_empty());
    let mut prev_freq = f64::INFINITY;
    for entry in values {
        assert!(entry["value"].is_string());
        assert_freq(&entry["freq"], "users.is_active common-value freq");
        // spec/protocol.md §5.5: "most frequent first".
        let freq = entry["freq"].as_f64().unwrap();
        assert!(
            freq <= prev_freq,
            "common-values must be sorted most-frequent-first: {values:?}"
        );
        prev_freq = freq;
    }
    let rendered: Vec<&str> = values
        .iter()
        .map(|v| v["value"].as_str().unwrap())
        .collect();
    // `users.is_active` is seeded with random_bool(0.85) over 50 rows, so
    // both outcomes are present; the point of this assertion is that they
    // render as "true"/"false", not Postgres's abbreviated `t`/`f` array
    // literal form.
    assert!(
        rendered.contains(&"true") && rendered.contains(&"false"),
        "expected both true and false, got {rendered:?}"
    );
    assert!(
        !rendered.iter().any(|v| *v == "t" || *v == "f"),
        "boolean values should not be Postgres's abbreviated array literal form: {rendered:?}"
    );
}

/// spec/protocol.md §5.5: a column with no planner statistics MUST yield an
/// empty `values` list, not an error. `feature_flags` is deliberately never
/// ANALYZEd (`conformance/seed/README.md`).
#[tokio::test]
async fn no_stats_column_yields_empty_values_not_error() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/common-values"))
        .query(&[("table", "feature_flags"), ("column", "enabled")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 200, "common-values on a never-analyzed column");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(
        body["values"].as_array().unwrap().len(),
        0,
        "expected an empty list, not an error: {body}"
    );
}

#[tokio::test]
async fn invalid_table_or_column_is_rejected_cleanly() {
    let srv = TestServer::spawn().await;

    let resp = srv
        .client()
        .get(srv.url("/api/tables/common-values"))
        .query(&[("table", "nonexistent"), ("column", "id")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "table=nonexistent");

    let resp = srv
        .client()
        .get(srv.url("/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "nonexistent")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "column=nonexistent");
}

#[tokio::test]
async fn column_belonging_to_a_different_table_is_rejected() {
    let srv = TestServer::spawn().await;
    // `sku` is a `products` column, not a `users` column.
    let resp = srv
        .client()
        .get(srv.url("/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "sku")])
        .send()
        .await
        .unwrap();
    assert_status(
        &resp,
        400,
        "table=users&column=sku (sku belongs to products)",
    );
}
