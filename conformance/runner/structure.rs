//! `spec/protocol.md` §5.10 `GET /api/tables/structure` — a table's indexes
//! and whole-object constraints. Verified against the seed's `users`,
//! `orders`, `events`, `reviews`, `inventory_counts` and `feature_flags`
//! (`conformance/seed/README.md`). Index and FK-action fixtures are named
//! identically in all three dialect seeds, so most assertions are shared;
//! only genuine engine gaps branch through `Backend`.

use crate::assert::{assert_exact, assert_status};
use crate::backend::{
    Backend, CheckConstraints, CrossSchemaReferrers, ExpressionIndexes, PartialIndexes,
};
use crate::common::TestServer;
use serde_json::{json, Value};

async fn structure(srv: &TestServer, table: &str) -> Value {
    srv.client()
        .get(srv.url("/api/tables/structure"))
        .query(&[("table", table)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn array<'a>(v: &'a Value, what: &str) -> &'a Vec<Value> {
    v.as_array()
        .unwrap_or_else(|| panic!("{what} must be an array: {v:#?}"))
}

fn index<'a>(body: &'a Value, name: &str) -> &'a Value {
    array(&body["indexes"], "indexes")
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("indexes missing {name}: {body:#?}"))
}

fn fk<'a>(body: &'a Value, from_cols: &[&str]) -> &'a Value {
    array(&body["constraints"]["foreign_keys"], "foreign_keys")
        .iter()
        .find(|f| {
            let cols: Vec<&str> = array(&f["columns"], "columns")
                .iter()
                .map(|c| c["from"].as_str().unwrap())
                .collect();
            cols == from_cols
        })
        .unwrap_or_else(|| panic!("foreign_keys missing {from_cols:?}: {body:#?}"))
}

/// P5.10-SHAPE: `indexes` and the four `constraints` members are always
/// present; the primary key and a single-column unique constraint carry
/// their columns. Constraint names are not asserted — they differ by engine.
#[tokio::test]
async fn reports_primary_key_unique_and_always_present_lists() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "users").await;

    array(&body["indexes"], "indexes");
    assert_exact(
        body["constraints"]["primary_key"]["columns"].clone(),
        json!(["id"]),
        "users primary key columns",
    );
    let unique = array(&body["constraints"]["unique"], "constraints.unique");
    assert!(
        unique.iter().any(|u| u["columns"] == json!(["email"])),
        "users must report its UNIQUE (email): {unique:#?}"
    );
    array(&body["constraints"]["foreign_keys"], "foreign_keys");
    array(&body["constraints"]["check"], "check");
}

/// P5.10-EMPTY-LISTS: a table with no foreign keys or checks reports `[]`
/// for both, never an omitted field or an error.
#[tokio::test]
async fn a_table_without_fks_or_checks_reports_empty_lists() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "feature_flags").await;
    assert_exact(
        body["constraints"]["foreign_keys"].clone(),
        json!([]),
        "feature_flags foreign_keys",
    );
    assert_exact(
        body["constraints"]["check"].clone(),
        json!([]),
        "feature_flags check",
    );
}

/// P5.10-COMPOSITE-FK: a composite FK is one entry with every column pair
/// in constraint order and the referenced `table`; same-schema → no `schema`.
#[tokio::test]
async fn composite_foreign_keys_are_one_entry_with_every_column_pair() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "inventory_counts").await;
    let entry = fk(&body, &["warehouse_code", "bin_code"]);
    assert_exact(
        entry["table"].clone(),
        json!("inventory_locations"),
        "composite FK referenced table",
    );
    assert_exact(
        entry["columns"].clone(),
        json!([
            {"from": "warehouse_code", "to": "warehouse_code"},
            {"from": "bin_code", "to": "bin_code"}
        ]),
        "composite FK column pairs",
    );
    assert!(
        entry.as_object().unwrap().get("schema").is_none(),
        "a same-schema FK must omit `schema`: {entry:#?}"
    );
    assert!(
        entry["name"].as_str().is_some_and(|s| !s.is_empty()),
        "FK `name` must be a non-empty string: {entry:#?}"
    );
}

/// P5.10-FK-ACTIONS: `on_delete`/`on_update` use the fixed vocabulary; an
/// FK with no action clause reports the engine default.
#[tokio::test]
async fn foreign_key_actions_use_the_fixed_vocabulary() {
    let srv = TestServer::spawn().await;
    let defaults = Backend::current().default_fk_actions();

    let orders = structure(&srv, "orders").await;
    let e = fk(&orders, &["user_id"]);
    assert_exact(
        e["on_delete"].clone(),
        json!("CASCADE"),
        "orders.user_id on_delete",
    );
    assert!(
        defaults.contains(&e["on_update"].as_str().unwrap()),
        "orders.user_id on_update must be the engine default {defaults:?}: {e:#?}"
    );

    let events = structure(&srv, "events").await;
    let e = fk(&events, &["user_id"]);
    assert_exact(
        e["on_delete"].clone(),
        json!("SET NULL"),
        "events.user_id on_delete",
    );
    assert_exact(
        e["on_update"].clone(),
        json!("CASCADE"),
        "events.user_id on_update",
    );

    let counts = structure(&srv, "inventory_counts").await;
    let e = fk(&counts, &["product_id"]);
    for action in ["on_delete", "on_update"] {
        assert!(
            defaults.contains(&e[action].as_str().unwrap()),
            "inventory_counts.product_id {action} must be the engine default {defaults:?}: {e:#?}"
        );
    }
}

/// P5.10-INDEX-COLUMNS: key columns come back in index order; an `INCLUDE`
/// column is not a key column (Postgres seeds one on this index).
#[tokio::test]
async fn index_columns_are_the_key_columns_in_order() {
    let srv = TestServer::spawn().await;
    let users = structure(&srv, "users").await;
    let idx = index(&users, "users_active_login_idx");
    assert_exact(
        idx["columns"].clone(),
        json!(["is_active", "last_login_at"]),
        "users_active_login_idx key columns",
    );
    assert_exact(
        idx["unique"].clone(),
        json!(false),
        "users_active_login_idx unique",
    );
    assert!(
        idx["method"]
            .as_str()
            .is_some_and(|m| m.eq_ignore_ascii_case("btree")),
        "method must be btree: {idx:#?}"
    );

    let reviews = structure(&srv, "reviews").await;
    assert_exact(
        index(&reviews, "reviews_product_created_idx")["columns"].clone(),
        json!(["product_id", "created_at"]),
        "reviews_product_created_idx key columns",
    );
}

/// P5.10-INDEX-UNIQUE: an index backing a UNIQUE constraint is listed and
/// flagged `unique`.
#[tokio::test]
async fn a_unique_constraint_backing_index_is_listed_as_unique() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "users").await;
    let found = array(&body["indexes"], "indexes")
        .iter()
        .any(|i| i["unique"] == json!(true) && i["columns"] == json!(["email"]));
    assert!(found, "no unique index on (email): {body:#?}");
}

/// P5.10-INDEX-PARTIAL: a partial index carries `predicate`; an engine with
/// no partial indexes never emits the field.
#[tokio::test]
async fn partial_index_predicate_is_reported_where_supported() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "orders").await;
    match Backend::current().partial_indexes() {
        PartialIndexes::Reported => {
            let idx = index(&body, "orders_pending_idx");
            assert_exact(
                idx["columns"].clone(),
                json!(["user_id"]),
                "orders_pending_idx columns",
            );
            assert!(
                idx["predicate"]
                    .as_str()
                    .is_some_and(|p| p.contains("pending")),
                "predicate must carry the WHERE text: {idx:#?}"
            );
        }
        PartialIndexes::NeverEmitted => {
            for i in array(&body["indexes"], "indexes") {
                assert!(
                    i.as_object().unwrap().get("predicate").is_none(),
                    "this engine has no partial indexes: {i:#?}"
                );
            }
        }
    }
    let plain = structure(&srv, "users").await;
    assert!(
        index(&plain, "users_active_login_idx")
            .as_object()
            .unwrap()
            .get("predicate")
            .is_none(),
        "a non-partial index must omit `predicate`, never null"
    );
}

/// P5.10-INDEX-EXPRESSION: an expression entry stays in its position as its
/// expression text instead of being dropped (Postgres seeds one).
#[tokio::test]
async fn expression_index_entries_are_kept_as_expression_text() {
    let srv = TestServer::spawn().await;
    if let ExpressionIndexes::NotSeeded = Backend::current().expression_indexes() {
        eprintln!("structure: skipping expression-index check — this dialect's seed has none");
        return;
    }
    let body = structure(&srv, "users").await;
    let cols = array(&index(&body, "users_email_lower_idx")["columns"], "columns");
    assert_eq!(cols.len(), 1, "one key entry expected: {cols:#?}");
    let text = cols[0].as_str().unwrap().to_ascii_lowercase();
    assert!(
        text.contains("lower") && text.contains("email"),
        "expression entry must be its text, got {text:?}"
    );
}

/// P5.10-CHECK: a named check carries its SQL text where the engine can
/// introspect checks; SQLite reports `[]`.
#[tokio::test]
async fn check_constraints_are_reported_where_introspectable() {
    let srv = TestServer::spawn().await;
    let body = structure(&srv, "reviews").await;
    let checks = array(&body["constraints"]["check"], "check");
    match Backend::current().check_constraints() {
        CheckConstraints::Introspected => {
            let c = checks
                .iter()
                .find(|c| c["name"] == "reviews_rating_check")
                .unwrap_or_else(|| panic!("check missing reviews_rating_check: {checks:#?}"));
            assert!(
                c["expression"]
                    .as_str()
                    .is_some_and(|e| e.to_ascii_lowercase().contains("rating")),
                "check expression must carry the SQL text: {c:#?}"
            );
        }
        CheckConstraints::AlwaysEmpty => {
            assert_exact(
                body["constraints"]["check"].clone(),
                json!([]),
                "SQLite check",
            );
        }
    }
}

/// P5.10-CROSS-SCHEMA: an FK into another schema carries the referenced
/// table's `schema`. MySQL scopes to one database and SQLite has one schema,
/// so both self-skip.
#[tokio::test]
async fn cross_schema_foreign_keys_carry_the_referenced_schema() {
    let srv = TestServer::spawn().await;
    if let CrossSchemaReferrers::ScopedToResolvedSchema =
        Backend::current().cross_schema_referrers()
    {
        eprintln!(
            "structure: skipping cross-schema check — this backend has no cross-schema FK fixture"
        );
        return;
    }
    let body: Value = srv
        .client()
        .get(srv.url("/api/tables/structure"))
        .query(&[("table", "shipments"), ("schema", "warehouse")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let e = fk(&body, &["order_id"]);
    assert_exact(e["table"].clone(), json!("orders"), "cross-schema FK table");
    assert_exact(
        e["schema"].clone(),
        json!("public"),
        "cross-schema FK schema",
    );
}

/// P5.10-TABLE-EXACT-MATCH: `table` must match §5.2 exactly; anything else,
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
            .get(srv.url("/api/tables/structure"))
            .query(&[("table", evil)])
            .send()
            .await
            .unwrap();
        assert_status(
            &resp,
            400,
            &format!("GET /api/tables/structure?table={evil:?}"),
        );
    }
    let resp = srv
        .client()
        .get(srv.url("/api/tables/structure"))
        .send()
        .await
        .unwrap();
    assert_status(
        &resp,
        400,
        "GET /api/tables/structure with no `table` param",
    );
}

/// P5.10-SCHEMA-PARAM: an explicit default `schema` resolves identically to
/// an absent one; an unknown `schema` is a 400.
#[tokio::test]
async fn schema_param_resolves_like_the_other_routes() {
    let srv = TestServer::spawn().await;
    let default_schema = Backend::current().default_schema();

    let implicit = structure(&srv, "users").await;
    let explicit: Value = srv
        .client()
        .get(srv.url("/api/tables/structure"))
        .query(&[("table", "users"), ("schema", default_schema.as_str())])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        explicit,
        implicit,
        "explicit default schema resolves like an absent one",
    );

    let resp = srv
        .client()
        .get(srv.url("/api/tables/structure"))
        .query(&[("table", "users"), ("schema", "no_such_schema")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "structure with an unknown schema");
}

/// P5.10-SOURCE-PARAM: an unknown `source` is a 400.
#[tokio::test]
async fn unknown_source_is_rejected() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/structure"))
        .query(&[("table", "users"), ("source", "no_such_source")])
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "structure with an unknown source");
}

/// P5.10-HEADER: the protocol version header rides every response, 200 or 400.
#[tokio::test]
async fn every_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    for (query, label) in [
        (vec![("table", "users")], "200"),
        (vec![("table", "nope")], "400"),
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/structure"))
            .query(&query)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.headers()
                .get("x-ashurbanipal-protocol")
                .and_then(|v| v.to_str().ok()),
            Some("1"),
            "structure {label} response header"
        );
    }
}
