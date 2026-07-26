use crate::assert::{assert_exact, assert_row_estimate, assert_status};
use crate::common::TestServer;

#[tokio::test]
async fn returns_requested_shape_and_row_count() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "users"), ("limit", "5")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert!(body["columns"].is_array());
    assert_row_estimate(&body["total_approx"], "users total_approx");
    let rows = body["rows"].as_array().unwrap();
    assert_exact(rows.len(), 5, "rows.len() for limit=5");

    let columns = body["columns"].as_array().unwrap();
    let id_col = columns.iter().find(|c| c["name"] == "id").unwrap();
    assert_exact(
        id_col["key"].clone(),
        serde_json::json!("pk"),
        "users.id key",
    );
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
            .get(srv.url("/api/tables/data"))
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
        assert_exact(
            col["key"].clone(),
            serde_json::json!("fk"),
            &format!("{table}.{fk_column} key"),
        );
        assert_exact(
            col["references"].clone(),
            serde_json::json!({"table": "users", "column": "id"}),
            &format!("{table}.{fk_column} references"),
        );
    }
}

/// spec/protocol.md §5.4.1: composite FKs MUST be omitted from
/// `key`/`references` entirely. `inventory_counts.(warehouse_code,
/// bin_code)` is a composite FK to `inventory_locations`; `product_id` on
/// the same table is an ordinary single-column FK, included as a contrast
/// so this test can't pass by coincidentally omitting everything.
#[tokio::test]
async fn composite_foreign_key_columns_omit_key_metadata() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "inventory_counts"), ("limit", "1")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let columns = body["columns"].as_array().unwrap();
    let col = |name: &str| -> &serde_json::Value {
        columns
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("inventory_counts has no {name} column"))
    };

    for composite_member in ["warehouse_code", "bin_code"] {
        let c = col(composite_member).as_object().unwrap();
        assert!(
            !c.contains_key("key") && !c.contains_key("references"),
            "inventory_counts.{composite_member} is half of a composite FK and must carry \
             no key/references metadata, got {c:?}"
        );
    }
    assert_exact(
        col("product_id")["key"].clone(),
        serde_json::json!("fk"),
        "inventory_counts.product_id key",
    );
    assert_exact(
        col("product_id")["references"].clone(),
        serde_json::json!({"table": "products", "column": "id"}),
        "inventory_counts.product_id references",
    );
}

/// spec/protocol.md §5.4.1: `comment` is `COMMENT ON COLUMN` text, omitted
/// (not present at all) when absent.
#[tokio::test]
async fn column_comments_are_present_only_where_seeded() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "orders"), ("limit", "1")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let columns = body["columns"].as_array().unwrap();
    let col =
        |name: &str| -> &serde_json::Value { columns.iter().find(|c| c["name"] == name).unwrap() };
    assert_exact(
        col("user_id")["comment"].clone(),
        serde_json::json!("The user who placed this order."),
        "orders.user_id comment",
    );
    assert!(col("discount_pct")["comment"].is_string());
    assert!(
        !col("total_cents")
            .as_object()
            .unwrap()
            .contains_key("comment"),
        "orders.total_cents should have no comment key at all"
    );
}

/// spec/protocol.md §5.4.3: every cell crosses the wire as a JSON string or
/// `null` — never a number, boolean, or nested object/array, regardless of
/// the column's real type. Picks one column of each of those "tempting to
/// leak the native JSON type" shapes: integer, boolean, jsonb.
#[tokio::test]
async fn every_cell_value_is_a_json_string_or_null() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "users"), ("limit", "10")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for row in body["rows"].as_array().unwrap() {
        for field in ["login_count", "is_active", "metadata", "id", "created_at"] {
            let v = &row[field];
            assert!(
                v.is_string() || v.is_null(),
                "users.{field} = {v} is not a JSON string or null"
            );
        }
    }
}

#[tokio::test]
async fn limit_defaults_to_fifty_and_clamps_to_configured_range() {
    let srv = TestServer::spawn().await;

    // `events` has 400 seeded rows, so a default (unset) limit exercises the
    // real default rather than being capped by table size.
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(body["rows"].as_array().unwrap().len(), 50, "default limit");

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events"), ("limit", "1000")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        100,
        "limit should clamp to the configured max of 100",
    );

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events"), ("limit", "0")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        1,
        "limit should clamp to a minimum of 1",
    );
}

/// The default/1000/0 cases above already prove clamping happens; this
/// pins the exact boundary so an off-by-one (99 instead of 100, or 100
/// instead of clamping 101) can't hide behind a test that only ever tries
/// values far from the edge.
#[tokio::test]
async fn limit_boundary_values_are_not_off_by_one() {
    let srv = TestServer::spawn().await;

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events"), ("limit", "100")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        100,
        "limit=100 (the max itself) should be accepted unclamped",
    );

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events"), ("limit", "101")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        100,
        "limit=101 (one past the max) should clamp down to 100",
    );

    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "events"), ("limit", "1")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        1,
        "limit=1 (the min itself) should be accepted unclamped",
    );
}

#[tokio::test]
async fn offset_is_unclamped_and_beyond_table_size_returns_empty_rows() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "users"), ("offset", "10000")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 200, "offset=10000 beyond table size");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        0,
        "rows beyond table size",
    );
    assert_row_estimate(&body["total_approx"], "users total_approx at offset=10000");
}

#[tokio::test]
async fn sort_and_order_are_respected() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables/data"))
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
    assert_exact(emails, sorted, "descending email order");
}

/// Regression test for a real bug found while building the Playwright E2E
/// suite (2026-07-19, now fixed): every column
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
        .get(srv.url("/api/tables/data"))
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
    assert_exact(
        prices,
        sorted,
        "real numeric ascending order, not lexicographic string order",
    );
}

#[tokio::test]
async fn invalid_order_value_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "users"), ("order", "sideways")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "order=sideways");
}

/// spec/protocol.md §5.4: `table` MUST match a table from §5.2 exactly
/// (case-sensitive) — a case variant of a real table is still an unknown
/// table, not a fuzzy match.
#[tokio::test]
async fn table_param_match_is_case_sensitive() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "Users")])
        .send()
        .await
        .unwrap();
    assert_status(
        &resp,
        400,
        "table=Users (real table is lowercase \"users\")",
    );
}

/// The crux of this suite: no unvalidated identifier ever reaches SQL.
/// Every one of these should be a clean rejection — never a 500, never a
/// hang, and never actual damage to the schema. Per the status-only error
/// tier (docs/design.md §4.2), only the status code is pinned — the
/// body's exact wording is implementation-defined (spec/protocol.md §2).
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
            .get(srv.url("/api/tables/data"))
            .query(&[("table", evil)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("table={evil:?}"));
    }

    // Confirm no damage: the table list is unchanged after the attempts above.
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/tables"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body["tables"].as_array().unwrap().len(),
        14,
        "table count after injection attempts",
    );
}

#[tokio::test]
async fn malicious_sort_value_against_a_valid_table_is_rejected_cleanly() {
    let srv = TestServer::spawn().await;
    for evil in ["nonexistent_column", "email\"; drop table users; --"] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/data"))
            .query(&[("table", "users"), ("sort", evil)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("sort={evil:?}"));
    }
}
