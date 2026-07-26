//! Executable spec for the `filter` query param's wire format: a
//! URL-encoded JSON AST (`spec/protocol.md` §5.4.2), never DSL text.
//! Grammar parsing (DSL text → AST) is frontend-only now
//! (`spec/filter-dsl.md`, exercised by
//! `tools/e2e-tests/tests/filter-parser.spec.ts` against
//! `spec/fixtures/parser-tests.json`) — nothing here sends DSL text except
//! the one regression case proving the server rejects it.
//!
//! The bulk is fixture-driven: every case in
//! `spec/fixtures/filter-builder-tests.json` (schema:
//! `spec/fixtures/README.md`) is JSON-encoded into a real `filter` param
//! exactly as the frontend would send it, and asserted 200 (valid AST) or
//! 400 (structural violation / allow-list rejection). The same file drives
//! `src/db.rs`'s unit runner, which additionally pins the exact WHERE
//! fragment + bind values — over HTTP only acceptance is observable, so
//! the named tests below add row-content assertions (against the
//! deterministic seed — `tools/seed-gen`, fixed RNG) for the semantics
//! that matter: equality narrowing, AND-tighter-than-OR precedence, NOT
//! negation, IS NULL, and injection values staying inert bind params.

use crate::assert::{assert_exact, assert_row_estimate, assert_status};
use crate::common::TestServer;

const BUILDER_FIXTURES: &str = include_str!("../../spec/fixtures/filter-builder-tests.json");

/// GETs `/tables/data?table=...&filter=...` and returns the raw response.
async fn fetch(srv: &TestServer, table: &str, filter: &str) -> reqwest::Response {
    srv.client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", table), ("filter", filter)])
        .send()
        .await
        .unwrap()
}

/// Serializes an AST (as a `serde_json::Value` array) into the `filter`
/// param and asserts 200, returning the body.
async fn assert_ast_accepted(
    srv: &TestServer,
    case: &str,
    table: &str,
    ast: serde_json::Value,
) -> serde_json::Value {
    let filter = serde_json::to_string(&ast).unwrap();
    let resp = fetch(srv, table, &filter).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_eq!(
        status, 200,
        "case {case} (filter {filter} against table {table:?}) should be accepted, got {status}: {body}"
    );
    serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("case {case} response wasn't valid JSON: {e}\nbody: {body}"))
}

// ==================== fixture sweep (filter-builder-tests.json) ====================

/// Every builder-fixture case over HTTP: valid ASTs are accepted, invalid
/// ones (bad op/arity/logic, over-limit, oversize, malformed JSON,
/// allow-list misses) are 400s. One server for the whole sweep.
#[tokio::test]
async fn builder_fixture_cases_over_http() {
    let srv = TestServer::spawn().await;
    let file: serde_json::Value = serde_json::from_str(BUILDER_FIXTURES).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let table = case["table"].as_str().unwrap();
        let filter = match case.get("raw") {
            Some(raw) => raw.as_str().unwrap().to_string(),
            None => serde_json::to_string(&case["conditions"]).unwrap(),
        };
        let resp = fetch(&srv, table, &filter).await;
        if case.get("expect").is_some() {
            assert_status(&resp, 200, &format!("case {name}: valid AST"));
        } else {
            let kind = case["expect_error"].as_str().unwrap();
            assert_status(&resp, 400, &format!("case {name}: {kind}"));
        }
    }
}

// ==================== wire-format regressions ====================

/// The explicit "old format is dead" case: DSL text in the `filter` param
/// isn't JSON, so it must 400 — no server-side grammar fallback.
#[tokio::test]
async fn dsl_text_in_filter_param_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = fetch(&srv, "orders", "status = completed").await;
    assert_status(
        &resp,
        400,
        "DSL text must no longer be understood by the server",
    );
}

/// Empty param and empty JSON array both mean "no filter" (§5.4.2).
#[tokio::test]
async fn empty_param_and_empty_array_mean_no_filter() {
    let srv = TestServer::spawn().await;
    for filter in ["", "[]"] {
        let resp = fetch(&srv, "users", filter).await;
        assert_status(
            &resp,
            200,
            &format!("filter {filter:?} treated as no filter"),
        );
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_exact(
            body["rows"].as_array().unwrap().len(),
            50,
            &format!("filter {filter:?} unfiltered default-size page"),
        );
    }
}

// ==================== row-content semantics ====================

/// Equality narrowing: `orders.status = completed` matches the 100/201
/// seeded completed orders and nothing else.
#[tokio::test]
async fn equality_filter_narrows_rows() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([{"column": "status", "op": "=", "value": "completed"}]);
    let body = assert_ast_accepted(&srv, "equality", "orders", ast).await;
    let rows = body["rows"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        assert_exact(
            row["status"].clone(),
            serde_json::json!("completed"),
            "orders.status",
        );
    }
}

/// Precedence: `A AND B OR C` groups as `(A AND B) OR C`. Seeded product
/// TOYS-1001 (category `toys`, `in_stock = true`) fails the AND pair but
/// must still appear via the OR branch; the wrong grouping
/// `A AND (B OR C)` would exclude it.
#[tokio::test]
async fn and_binds_tighter_than_or() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([
        {"column": "category", "op": "=", "value": "electronics"},
        {"logic": "AND", "column": "created_on", "op": ">", "value": "2016-01-01"},
        {"logic": "OR", "column": "in_stock", "op": "=", "value": "true"},
    ]);
    let body = assert_ast_accepted(&srv, "precedence", "products", ast).await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.iter().any(|r| r["sku"] == "TOYS-1001"),
        "TOYS-1001 should match via the OR branch under (A AND B) OR C grouping"
    );
}

/// `not: true` wraps the fragment in NOT (...): the complement of the 100
/// completed orders, and no completed row leaks through.
#[tokio::test]
async fn not_negates_a_condition() {
    let srv = TestServer::spawn().await;
    let ast =
        serde_json::json!([{"not": true, "column": "status", "op": "=", "value": "completed"}]);
    let body = assert_ast_accepted(&srv, "not", "orders", ast).await;
    let rows = body["rows"].as_array().unwrap();
    assert_exact(
        rows.len(),
        50,
        "a full default page of non-completed orders",
    );
    for row in rows {
        assert_ne!(row["status"], "completed");
    }
}

/// IS NULL / IS NOT NULL partition `users.last_login_at` into the seeded
/// 6/44 split.
#[tokio::test]
async fn is_null_and_is_not_null_partition_rows() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([{"column": "last_login_at", "op": "IS NULL"}]);
    let body = assert_ast_accepted(&srv, "is-null", "users", ast).await;
    let rows = body["rows"].as_array().unwrap();
    assert_exact(rows.len(), 6, "IS NULL row count");
    for row in rows {
        assert!(row["last_login_at"].is_null());
    }

    let ast = serde_json::json!([{"column": "last_login_at", "op": "IS NOT NULL"}]);
    let body = assert_ast_accepted(&srv, "is-not-null", "users", ast).await;
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        44,
        "IS NOT NULL row count",
    );
}

/// Contradictory conditions are legal (spec/protocol.md §5.4.2) and simply
/// return zero rows, not an error.
#[tokio::test]
async fn contradictory_conditions_return_zero_rows_not_error() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([
        {"column": "status", "op": "=", "value": "completed"},
        {"logic": "AND", "column": "status", "op": "=", "value": "pending"},
    ]);
    let body = assert_ast_accepted(&srv, "contradictory", "orders", ast).await;
    assert_exact(
        body["rows"].as_array().unwrap().len(),
        0,
        "contradictory AND should be zero rows, not an error",
    );
}

/// spec/protocol.md §5.4.4: `total_approx` MUST NOT be affected by
/// `filter` — it's the whole-table catalog estimate, not a filtered count.
#[tokio::test]
async fn total_approx_is_unaffected_by_filter() {
    let srv = TestServer::spawn().await;
    // `pending` orders are a small minority of the 208 seeded orders (31),
    // well under the default 50-row page — so the filtered response's row
    // count is a real narrowing, not just a smaller slice of a page cap
    // both requests would otherwise hit identically.
    let unfiltered = fetch(&srv, "orders", "")
        .await
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let ast = serde_json::json!([{"column": "status", "op": "=", "value": "pending"}]);
    let filtered = assert_ast_accepted(&srv, "total_approx-unaffected", "orders", ast).await;

    assert_row_estimate(
        &unfiltered["total_approx"],
        "orders total_approx (unfiltered)",
    );
    assert_row_estimate(&filtered["total_approx"], "orders total_approx (filtered)");
    assert_exact(
        filtered["total_approx"].clone(),
        unfiltered["total_approx"].clone(),
        "total_approx must be identical filtered vs unfiltered",
    );
    // The filter itself did narrow the rows returned — otherwise this test
    // wouldn't distinguish "correctly unaffected" from "filter silently
    // ignored".
    assert!(
        filtered["rows"].as_array().unwrap().len() < unfiltered["rows"].as_array().unwrap().len()
    );
}

/// An injection-shaped value stays an inert bind param: the request
/// succeeds with zero matches, and `users` is still there afterwards.
#[tokio::test]
async fn injection_value_stays_a_bind_param() {
    let srv = TestServer::spawn().await;
    let ast =
        serde_json::json!([{"column": "status", "op": "=", "value": "'; DROP TABLE users; --"}]);
    let body = assert_ast_accepted(&srv, "injection", "orders", ast).await;
    assert!(body["rows"].as_array().unwrap().is_empty());
    let users_still_exist = fetch(&srv, "users", "").await;
    assert_status(
        &users_still_exist,
        200,
        "`users` should still exist and be queryable — the value must never reach SQL text",
    );
}

/// A8/A10 equivalents live in the fixture sweep (`unknown-column`,
/// `not-does-not-bypass-allow-list`, `known-column-wrong-table`); this pins
/// the status for one of them directly. Per the status-only error tier
/// (docs/design.md §4.2), the body's exact wording is not asserted —
/// spec/protocol.md §2 makes it implementation-defined.
#[tokio::test]
async fn unknown_column_rejection_is_a_400() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([{"column": "pg_sleep", "op": "=", "value": "1"}]);
    let resp = fetch(&srv, "users", &serde_json::to_string(&ast).unwrap()).await;
    assert_status(
        &resp,
        400,
        "filter column=pg_sleep (not a real users column)",
    );
}
