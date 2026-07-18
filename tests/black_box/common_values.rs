use crate::common::TestServer;

#[tokio::test]
async fn returns_value_freq_pairs_with_booleans_as_text_not_pg_array_literals() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "is_active")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let values = body["values"].as_array().unwrap();
    assert!(!values.is_empty());
    for entry in values {
        assert!(entry["value"].is_string());
        assert!(entry["freq"].is_number());
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

#[tokio::test]
async fn invalid_table_or_column_is_rejected_cleanly() {
    let srv = TestServer::spawn().await;

    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/common-values"))
        .query(&[("table", "nonexistent"), ("column", "id")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "nonexistent")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn column_belonging_to_a_different_table_is_rejected() {
    let srv = TestServer::spawn().await;
    // `sku` is a `products` column, not a `users` column.
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/common-values"))
        .query(&[("table", "users"), ("column", "sku")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}
