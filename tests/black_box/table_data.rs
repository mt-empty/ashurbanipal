use crate::common::TestServer;

#[tokio::test]
async fn returns_requested_shape_and_row_count() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "users"), ("limit", "5")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert!(body["columns"].is_array());
    assert!(body["total_approx"].is_number());
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 5);

    let columns = body["columns"].as_array().unwrap();
    let id_col = columns.iter().find(|c| c["name"] == "id").unwrap();
    assert_eq!(id_col["key"], "pk");
    assert!(!id_col.as_object().unwrap().contains_key("references"));
}

#[tokio::test]
async fn foreign_key_columns_report_key_and_references() {
    let srv = TestServer::spawn().await;
    for (table, fk_column) in [
        ("orders", "user_id"),
        ("sessions", "user_id"),
        ("events", "user_id"),
    ] {
        let body: serde_json::Value = srv
            .client()
            .get(srv.url("/__ashurbanipal/api/tables/data"))
            .query(&[("table", table), ("limit", "1")])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let columns = body["columns"].as_array().unwrap();
        let col = columns
            .iter()
            .find(|c| c["name"] == fk_column)
            .unwrap_or_else(|| panic!("{table} has no {fk_column} column"));
        assert_eq!(col["key"], "fk", "{table}.{fk_column} should be fk");
        assert_eq!(
            col["references"],
            serde_json::json!({"table": "users", "column": "id"}),
            "{table}.{fk_column} should reference users.id"
        );
    }
}

#[tokio::test]
async fn limit_defaults_to_fifty_and_clamps_to_configured_range() {
    let srv = TestServer::spawn().await;

    // `events` has 400 seeded rows, so a default (unset) limit exercises the
    // real default rather than being capped by table size.
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "events")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["rows"].as_array().unwrap().len(), 50);

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "events"), ("limit", "1000")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["rows"].as_array().unwrap().len(),
        100,
        "limit should clamp to the configured max of 100"
    );

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "events"), ("limit", "0")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["rows"].as_array().unwrap().len(),
        1,
        "limit should clamp to a minimum of 1"
    );
}

#[tokio::test]
async fn offset_is_unclamped_and_beyond_table_size_returns_empty_rows() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "users"), ("offset", "10000")])
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["rows"].as_array().unwrap().len(), 0);
    assert!(body["total_approx"].is_number());
}

#[tokio::test]
async fn sort_and_order_are_respected() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "users"), ("sort", "email"), ("order", "desc")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let emails: Vec<&str> = body["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["email"].as_str().unwrap())
        .collect();
    let mut sorted = emails.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(emails, sorted, "rows should be in descending email order");
}

/// Regression test for a real bug (docs/known-issues.md #1): every column
/// is selected as `"col"::text` for uniform decoding, and an unqualified
/// `order by "col"` bound to that same-named *output* column instead of
/// the source column, sorting numeric columns lexicographically
/// ("107.92" < "11.18") instead of numerically. `email` above is a `text`
/// column, so the bug was invisible there — text-cast-to-text is a no-op,
/// meaning lexicographic and real order coincide for it. Needed a
/// non-text column specifically to catch this.
#[tokio::test]
async fn sort_on_a_numeric_column_is_numeric_not_lexicographic() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[
            ("table", "products"),
            ("sort", "price"),
            ("order", "asc"),
            ("limit", "100"),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let prices: Vec<f64> = body["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["price"].as_str().unwrap().parse().unwrap())
        .collect();
    let mut sorted = prices.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(
        prices, sorted,
        "rows should be in real numeric ascending order, not lexicographic string order"
    );
}

#[tokio::test]
async fn invalid_order_value_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "users"), ("order", "sideways")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

/// The crux of this suite: no unvalidated identifier ever reaches SQL.
/// Every one of these should be a clean rejection — never a 500, never a
/// hang, and never actual damage to the schema.
#[tokio::test]
async fn malicious_table_values_are_rejected_cleanly_and_do_no_damage() {
    let srv = TestServer::spawn().await;
    for evil in [
        "nonexistent",
        "users\"; drop table users; --",
        "users' OR '1'='1",
        "../../etc/passwd",
    ] {
        let resp = srv
            .client()
            .get(srv.url("/__ashurbanipal/api/tables/data"))
            .query(&[("table", evil)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            400,
            "table={evil:?} should be a clean 400, got {}",
            resp.status()
        );
        let body = resp.text().await.unwrap();
        assert!(
            body.starts_with("not allowed: table "),
            "unexpected body for table={evil:?}: {body}"
        );
    }

    // Confirm no damage: the table list is unchanged after the attempts above.
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["tables"].as_array().unwrap().len(), 10);
}

#[tokio::test]
async fn malicious_sort_value_against_a_valid_table_is_rejected_cleanly() {
    let srv = TestServer::spawn().await;
    for evil in ["nonexistent_column", "email\"; drop table users; --"] {
        let resp = srv
            .client()
            .get(srv.url("/__ashurbanipal/api/tables/data"))
            .query(&[("table", "users"), ("sort", evil)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            400,
            "sort={evil:?} should be a clean 400, got {}",
            resp.status()
        );
        let body = resp.text().await.unwrap();
        assert!(
            body.starts_with("not allowed: column "),
            "unexpected body for sort={evil:?}: {body}"
        );
    }
}
