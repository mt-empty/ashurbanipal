//! Executable spec for the `filter` query param's wire format: a
//! URL-encoded JSON AST (`spec/protocol.md` §5.4.2), never DSL text.
//! Grammar parsing (DSL text → AST) is frontend-only now
//! (`spec/filter-dsl.md`, exercised by `frontend/test/filter-dsl.test.ts`
//! against `spec/fixtures/parser-tests.json`) — nothing here sends DSL text
//! except the one regression case proving the server rejects it.
//!
//! The bulk is fixture-driven: every case in
//! `spec/fixtures/filter-builder-tests.json` (schema:
//! `spec/fixtures/README.md`) is JSON-encoded into a real `filter` param
//! exactly as the frontend would send it, and asserted 200 (valid AST) or
//! 400 (structural violation / allow-list rejection). The same file drives
//! `core/src/db/postgres.rs`'s `filter_builder_fixtures` unit runner, which
//! additionally pins the exact WHERE fragment + bind values — over HTTP
//! only acceptance is observable, so
//! the named tests below add row-content assertions (against the
//! deterministic seed — `tools/seed-gen`, fixed RNG) for the semantics
//! that matter: equality narrowing, AND-tighter-than-OR precedence, NOT
//! negation, IS NULL, typed comparison, IN/BETWEEN, and injection values
//! staying inert bind params.

use crate::assert::{assert_exact, assert_problem_code, assert_row_estimate, assert_status};
use crate::backend::{Backend, TypedValueCheck};
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

/// Column name → §5.4.1 `class`, from an unfiltered request.
async fn column_classes(
    srv: &TestServer,
    table: &str,
) -> std::collections::HashMap<String, String> {
    let body: serde_json::Value = fetch(srv, table, "").await.json().await.unwrap();
    body["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].as_str().unwrap().to_string(),
                c["class"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

const TYPED_CLASSES: [&str; 4] = ["number", "float", "temporal", "time"];

/// Every builder-fixture case over HTTP: valid ASTs are accepted, invalid
/// ones (bad op/arity/logic, over-limit, oversize, malformed JSON,
/// allow-list misses, values that do not fit a typed column) are 400s. One
/// server for the whole sweep. An `invalid_value` case is 200 where this
/// engine's seed declares the column as text, or where the engine skips the
/// check (SQLite), because only an enforced typed column checks its values.
#[tokio::test]
async fn builder_fixture_cases_over_http() {
    let srv = TestServer::spawn().await;
    let file: serde_json::Value = serde_json::from_str(BUILDER_FIXTURES).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut classes = std::collections::HashMap::new();
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
            continue;
        }
        let kind = case["expect_error"].as_str().unwrap();
        if kind == "invalid_value" {
            if Backend::current().typed_value_check() == TypedValueCheck::Skipped {
                assert_status(&resp, 200, &format!("case {name}: check skipped"));
                continue;
            }
            if !classes.contains_key(table) {
                classes.insert(table.to_string(), column_classes(&srv, table).await);
            }
            let typed = case["conditions"].as_array().unwrap().iter().any(|c| {
                classes[table]
                    .get(c["column"].as_str().unwrap())
                    .is_some_and(|class| TYPED_CLASSES.contains(&class.as_str()))
            });
            if !typed {
                assert_status(
                    &resp,
                    200,
                    &format!("case {name}: text column on this engine"),
                );
                continue;
            }
        }
        assert_status(&resp, 400, &format!("case {name}: {kind}"));
    }
}

// ==================== wire-format regressions ====================

/// The explicit "old format is dead" case: DSL text in the `filter` param
/// isn't JSON, so it must 400 — no server-side grammar fallback.
#[tokio::test]
async fn dsl_text_in_filter_param_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = fetch(&srv, "orders", "status = completed").await;
    // Representative site for `invalid_filter`.
    assert_problem_code(
        resp,
        400,
        "invalid_filter",
        "DSL text must no longer be understood by the server",
    )
    .await;
}

/// Malformed JSON → 400, including nesting deep enough to overflow a
/// recursive decoder while staying under the byte bound.
#[tokio::test]
async fn deeply_nested_filter_is_rejected() {
    let srv = TestServer::spawn().await;
    let deep = format!("{}{}", "[".repeat(2000), "]".repeat(2000));
    let resp = fetch(&srv, "orders", &deep).await;
    assert_problem_code(resp, 400, "invalid_filter", "filter nested 2000 deep").await;
}

/// Malformed input past the documented rules may be accepted or rejected, but
/// never a 5xx: a lone surrogate is one a database driver may fail to encode.
#[tokio::test]
async fn unnamed_malformed_filter_is_not_a_server_error() {
    let srv = TestServer::spawn().await;
    for (what, filter) in [
        (
            "lone surrogate in a value",
            r#"[{"column":"status","op":"=","value":"\ud800"}]"#,
        ),
        (
            "repeated key",
            r#"[{"column":"nope","column":"status","op":"IS NULL"}]"#,
        ),
    ] {
        let resp = fetch(&srv, "orders", filter).await;
        let status = resp.status();
        assert!(
            status == 200 || status == 400,
            "{what}: expected 200 or 400, got {status}: {}",
            resp.text().await.unwrap()
        );
    }
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
    // `in_stock` is a boolean; a text-compared filter value renders it
    // `true`/`false` on Postgres but `1`/`0` on MySQL/SQLite
    // (docs/adapter-decisions.md §5.4.2).
    let ast = serde_json::json!([
        {"column": "category", "op": "=", "value": "electronics"},
        {"logic": "AND", "column": "created_on", "op": ">", "value": "2016-01-01"},
        {"logic": "OR", "column": "in_stock", "op": "=", "value": Backend::current().bool_true_literal()},
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
    // A filter condition naming a nonexistent column is `unknown_column`,
    // not `invalid_filter` — the AST is structurally valid, only the
    // column fails the live allow-list (spec/protocol.md §2), same rule as
    // `sort`'s own unknown-column case.
    assert_problem_code(
        resp,
        400,
        "unknown_column",
        "filter column=pg_sleep (not a real users column)",
    )
    .await;
}

// ==================== typed comparison, IN, BETWEEN ====================
// Each engine's seed holds different rows, so expectations are computed
// from the unfiltered table rather than pinned.

/// Every row matching `filter` ("" for none), paging past the page cap.
async fn all_rows(
    srv: &TestServer,
    table: &str,
    filter: &serde_json::Value,
) -> Vec<serde_json::Value> {
    let filter = if filter.is_null() {
        String::new()
    } else {
        filter.to_string()
    };
    let mut rows = Vec::new();
    loop {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/data"))
            .query(&[
                ("table", table),
                ("filter", &filter),
                ("limit", "100"),
                ("offset", &rows.len().to_string()),
            ])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 200, &format!("{table} filter {filter}"));
        let body: serde_json::Value = resp.json().await.unwrap();
        let page = body["rows"].as_array().unwrap().clone();
        let done = page.len() < 100;
        rows.extend(page);
        if done {
            return rows;
        }
    }
}

fn texts(rows: &[serde_json::Value], column: &str) -> Vec<String> {
    rows.iter()
        .filter_map(|r| r[column].as_str().map(str::to_string))
        .collect()
}

/// A number column compares as a number (spec/protocol.md §5.4.2): every
/// seeded age is at least 18, so `age > 9` keeps every row with an age,
/// though the text "18" sorts below "9".
#[tokio::test]
async fn number_columns_compare_numerically() {
    let srv = TestServer::spawn().await;
    let with_age = texts(
        &all_rows(&srv, "users", &serde_json::Value::Null).await,
        "age",
    );
    assert!(with_age.iter().all(|a| a.parse::<i64>().unwrap() >= 10));
    let ast = serde_json::json!([{"column": "age", "op": ">", "value": "9"}]);
    let rows = all_rows(&srv, "users", &ast).await;
    assert_exact(
        rows.len(),
        with_age.len(),
        "every user with an age is above 9",
    );
}

/// Typed equality ignores the written scale: a price matches itself with
/// one more trailing zero (`12.5` = `12.50`), which the text cast would not.
#[tokio::test]
async fn typed_equality_ignores_scale() {
    let srv = TestServer::spawn().await;
    let prices = texts(
        &all_rows(&srv, "products", &serde_json::Value::Null).await,
        "price",
    );
    let price = &prices[0];
    let padded = if price.contains('.') {
        format!("{price}0")
    } else {
        format!("{price}.0")
    };
    let ast = serde_json::json!([{"column": "price", "op": "=", "value": padded}]);
    let rows = all_rows(&srv, "products", &ast).await;
    assert_exact(
        rows.len(),
        prices.iter().filter(|p| *p == price).count(),
        &format!("products priced {price}, filtered as {padded}"),
    );
}

/// BETWEEN is inclusive and typed; reversed bounds match nothing.
#[tokio::test]
async fn between_is_inclusive_and_typed() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([{"column": "id", "op": "BETWEEN", "value": ["9", "11"]}]);
    let mut ids = texts(&all_rows(&srv, "products", &ast).await, "id");
    ids.sort();
    assert_exact(
        ids,
        vec!["10".to_string(), "11".into(), "9".into()],
        "ids 9-11",
    );

    let ast = serde_json::json!([{"column": "id", "op": "BETWEEN", "value": ["11", "9"]}]);
    let rows = all_rows(&srv, "products", &ast).await;
    assert_exact(rows.len(), 0, "reversed BETWEEN bounds");
}

/// IN matches any listed value; `not` + IN excludes them, and like SQL's
/// NOT IN it also drops rows where the column is NULL.
#[tokio::test]
async fn in_and_not_in() {
    let srv = TestServer::spawn().await;
    let ast = serde_json::json!([{"column": "id", "op": "IN", "value": ["1", "2", "3"]}]);
    let rows = all_rows(&srv, "products", &ast).await;
    assert_exact(rows.len(), 3, "three listed ids");

    let all = all_rows(&srv, "users", &serde_json::Value::Null).await;
    let ages = texts(&all, "age");
    assert!(ages.len() < all.len(), "the seed has users with no age");
    let first = &ages[0];
    let ast = serde_json::json!([{"not": true, "column": "age", "op": "IN", "value": [first]}]);
    let rows = all_rows(&srv, "users", &ast).await;
    assert_exact(
        rows.len(),
        ages.iter().filter(|a| *a != first).count(),
        &format!("users with an age other than {first}"),
    );
}

/// Date and timestamp ranges select the rows whose ISO text falls in the
/// range (on SQLite, whose seed stores dates as TEXT, text order is the
/// comparison itself).
#[tokio::test]
async fn temporal_ranges() {
    let srv = TestServer::spawn().await;
    let mut days: Vec<String> = texts(
        &all_rows(&srv, "products", &serde_json::Value::Null).await,
        "created_on",
    )
    .into_iter()
    .map(|d| d[..10].to_string())
    .collect();
    days.sort();
    let (lo, hi) = (days[days.len() / 4].clone(), days[days.len() / 2].clone());
    let ast = serde_json::json!([{"column": "created_on", "op": "BETWEEN", "value": [lo, hi]}]);
    let rows = all_rows(&srv, "products", &ast).await;
    assert_exact(
        rows.len(),
        days.iter().filter(|d| **d >= lo && **d <= hi).count(),
        &format!("products created {lo} to {hi}"),
    );

    let mut stamps = texts(
        &all_rows(&srv, "users", &serde_json::Value::Null).await,
        "created_at",
    );
    stamps.sort();
    let cutoff = stamps[stamps.len() / 2][..10].to_string();
    let ast = serde_json::json!([{"column": "created_at", "op": "<", "value": cutoff}]);
    let rows = all_rows(&srv, "users", &ast).await;
    assert_exact(
        rows.len(),
        stamps.iter().filter(|s| s[..10] < *cutoff).count(),
        &format!("users created before {cutoff}"),
    );
}

/// A value that does not fit a typed column is a 400, never a silent
/// coercion (`'abc'` as 0) or a 5xx. Where the check is skipped (SQLite) it
/// is still never a 5xx.
#[tokio::test]
async fn a_value_that_does_not_fit_a_typed_column_is_invalid_filter() {
    let srv = TestServer::spawn().await;
    let enforced = Backend::current().typed_value_check() == TypedValueCheck::Enforced;
    for (table, ast) in [
        (
            "users",
            serde_json::json!([{"column": "age", "op": ">", "value": "abc"}]),
        ),
        (
            "products",
            serde_json::json!([{"column": "id", "op": "IN", "value": ["1", "x"]}]),
        ),
    ] {
        let resp = fetch(&srv, table, &ast.to_string()).await;
        if enforced {
            assert_problem_code(resp, 400, "invalid_filter", &ast.to_string()).await;
        } else {
            assert_status(&resp, 200, &ast.to_string());
        }
    }
}

/// A typed cell's own text filters back to its row, as click-to-filter
/// writes it: an engine that renders an offset (Postgres `timestamptz`)
/// must accept one, and a rendered number or date must fit its form.
#[tokio::test]
async fn a_typed_cells_own_text_filters_back_to_its_row() {
    let srv = TestServer::spawn().await;
    for (table, column) in [
        ("users", "age"),
        ("users", "created_at"),
        ("products", "price"),
        ("products", "weight_kg"),
        ("products", "created_on"),
    ] {
        let all = all_rows(&srv, table, &serde_json::Value::Null).await;
        let values = texts(&all, column);
        let value = &values[0];
        let ast = serde_json::json!([{"column": column, "op": "=", "value": value}]);
        let rows = all_rows(&srv, table, &ast).await;
        assert!(
            rows.iter().any(|r| r[column].as_str() == Some(value)),
            "{table}.{column} = {value:?} should find its own row"
        );
    }
}
