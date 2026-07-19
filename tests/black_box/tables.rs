use crate::common::TestServer;

const SEEDED_TABLES: [&str; 10] = [
    "audit_log",
    "events",
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
async fn lists_exactly_the_ten_seeded_tables_in_alphabetical_order() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables"))
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
    assert_eq!(names, SEEDED_TABLES);
}

#[tokio::test]
async fn table_comments_are_present_only_where_seeded() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables"))
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

    for commented in ["users", "orders", "sessions", "reviews", "support_tickets"] {
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
        .get(srv.url("/__ashurbanipal/api/table-counts"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let counts = body["counts"].as_array().unwrap();
    assert_eq!(counts.len(), 10);

    let mut names: Vec<&str> = counts
        .iter()
        .map(|c| c["table"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, SEEDED_TABLES);

    for entry in counts {
        assert!(
            entry["approx_rows"].is_number(),
            "approx_rows should be a number for {entry}"
        );
    }
}
