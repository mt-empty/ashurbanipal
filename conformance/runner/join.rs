//! `spec/protocol.md` §5.11 `GET /api/tables/join` — structured joins over
//! the seed's `orders`, `users` and `order_extra`. Those three tables have
//! the same names and relationships in all three dialect seeds, so most
//! assertions are shared; column values differ by engine (uuid vs integer
//! ids), so rows are compared by relation, never by literal.
//!
//! The §6 timeout bound is not provokable over black-box HTTP (see
//! `COVERAGE.md`); each port covers the `query_timeout` label in its own tests.

use crate::assert::{assert_exact, assert_problem_code, assert_status};
use crate::backend::{Backend, NotJoinableColumns, SchemaModel};
use crate::common::TestServer;
use serde_json::{json, Value};

async fn get_join(srv: &TestServer, join: &Value, extra: &[(&str, String)]) -> reqwest::Response {
    let mut query: Vec<(&str, String)> = vec![("join", join.to_string())];
    query.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
    srv.client()
        .get(srv.url("/api/tables/join"))
        .query(&query)
        .send()
        .await
        .unwrap()
}

async fn ok_body(srv: &TestServer, join: &Value, extra: &[(&str, String)]) -> Value {
    let resp = get_join(srv, join, extra).await;
    assert_status(&resp, 200, "join request");
    resp.json().await.unwrap()
}

async fn data(srv: &TestServer, table: &str, extra: &[(&str, String)]) -> Value {
    let mut query: Vec<(&str, String)> = vec![("table", table.to_string())];
    query.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
    srv.client()
        .get(srv.url("/api/tables/data"))
        .query(&query)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn orders_users(kind: &str) -> Value {
    json!({
        "table": "orders",
        "joins": [{
            "type": kind, "table": "users",
            "on": [{"left": {"join": 0, "column": "user_id"}, "right": "id"}]
        }]
    })
}

fn orders_extra(kind: &str) -> Value {
    json!({
        "table": "orders",
        "joins": [{
            "type": kind, "table": "order_extra",
            "on": [{"left": {"join": 0, "column": "id"}, "right": "order_id"}]
        }],
        "columns": [{"join": 0, "column": "id"}, {"join": 1, "column": "order_id"}]
    })
}

fn three_tables() -> Value {
    json!({
        "table": "orders",
        "joins": [
            {"type": "left", "table": "users",
             "on": [{"left": {"join": 0, "column": "user_id"}, "right": "id"}]},
            {"type": "left", "table": "order_extra",
             "on": [{"left": {"join": 0, "column": "id"}, "right": "order_id"}]}
        ]
    })
}

fn self_join() -> Value {
    json!({
        "table": "orders",
        "joins": [{
            "type": "inner", "table": "orders",
            "on": [{"left": {"join": 0, "column": "user_id"}, "right": "user_id"}]
        }],
        "columns": [{"join": 0, "column": "id"}, {"join": 1, "column": "id"}]
    })
}

/// The label the server chose for column `(join, column)`.
fn label(body: &Value, join: u64, column: &str) -> String {
    body["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["join"] == join && c["column"] == column)
        .unwrap_or_else(|| panic!("no column ({join}, {column}) in {body:#?}"))["name"]
        .as_str()
        .unwrap()
        .to_string()
}

fn rows(body: &Value) -> &Vec<Value> {
    body["rows"].as_array().unwrap()
}

/// P5.11-SHAPE: `columns` entries carry `name`, `type`, `join`, `table`,
/// `column`; `rows` are keyed by label; `has_more` is present and
/// `total_approx` never is.
#[tokio::test]
async fn response_shape_has_join_metadata_and_no_total() {
    let srv = TestServer::spawn().await;
    let body = ok_body(&srv, &orders_users("left"), &[("limit", "3".into())]).await;

    assert!(body["has_more"].is_boolean(), "has_more: {body:#?}");
    assert!(
        body.get("total_approx").is_none(),
        "total_approx must be absent: {body:#?}"
    );
    let names: Vec<&str> = body["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            assert!(c["type"].is_string() && c["table"].is_string() && c["column"].is_string());
            assert!(c["join"].is_u64());
            c["name"].as_str().unwrap()
        })
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_exact(sorted.len(), names.len(), "labels are unique");
    for row in rows(&body) {
        let mut keys: Vec<&str> = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_exact(keys, sorted.clone(), "row keys are the labels");
    }
}

/// P5.11-COLUMN-METADATA: §5.4.1 `key`/`references` apply per table.
#[tokio::test]
async fn column_metadata_is_carried_per_table() {
    let srv = TestServer::spawn().await;
    let body = ok_body(&srv, &orders_users("left"), &[("limit", "1".into())]).await;
    let columns = body["columns"].as_array().unwrap();
    let fk = columns
        .iter()
        .find(|c| c["join"] == 0 && c["column"] == "user_id")
        .unwrap();
    assert_exact(fk["key"].clone(), json!("fk"), "orders.user_id key");
    assert_exact(
        fk["references"].clone(),
        json!({"table": "users", "column": "id"}),
        "orders.user_id references",
    );
    let pk = columns
        .iter()
        .find(|c| c["join"] == 1 && c["column"] == "id")
        .unwrap();
    assert_exact(pk["key"].clone(), json!("pk"), "users.id key");
    assert_exact(pk["table"].clone(), json!("users"), "users.id table");
}

/// P5.11-LEFT-INNER: `left` keeps base rows with no match, as nulls;
/// `inner` drops them.
#[tokio::test]
async fn left_keeps_unmatched_rows_and_inner_drops_them() {
    let srv = TestServer::spawn().await;
    let args = [("limit", "100".into()), ("sort", "id".to_string())];

    let left = ok_body(&srv, &orders_extra("left"), &args).await;
    let order_id = label(&left, 1, "order_id");
    let nulls = rows(&left)
        .iter()
        .filter(|r| r[&order_id].is_null())
        .count();
    let matched = rows(&left).len() - nulls;
    assert!(nulls > 0, "left join must keep unmatched orders: {left:#?}");
    assert!(matched > 0, "seed has orders with an order_extra row");

    let inner = ok_body(&srv, &orders_extra("inner"), &args).await;
    let order_id = label(&inner, 1, "order_id");
    assert!(!rows(&inner).is_empty());
    assert!(
        rows(&inner).iter().all(|r| !r[&order_id].is_null()),
        "inner join must drop unmatched rows: {inner:#?}"
    );
}

/// P5.11-THREE-TABLES: each table's columns appear once, in position order,
/// and the labels stay unique where column names repeat (`created_at`).
#[tokio::test]
async fn three_table_join_returns_every_tables_columns() {
    let srv = TestServer::spawn().await;
    let body = ok_body(&srv, &three_tables(), &[("limit", "5".into())]).await;
    let tables: Vec<(u64, &str)> = body["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["join"].as_u64().unwrap(), c["table"].as_str().unwrap()))
        .collect();
    for (join, table) in [(0, "orders"), (1, "users"), (2, "order_extra")] {
        assert!(
            tables.contains(&(join, table)),
            "missing a column from ({join}, {table}): {tables:?}"
        );
    }
    let positions: Vec<u64> = tables.iter().map(|t| t.0).collect();
    assert!(positions.windows(2).all(|w| w[0] <= w[1]), "{positions:?}");
    let created: Vec<String> = (0..3).map(|j| label(&body, j, "created_at")).collect();
    assert!(
        created[0] != created[1] && created[1] != created[2] && created[0] != created[2],
        "created_at labels must differ: {created:?}"
    );
}

/// P5.11-SELF-JOIN: the same table at two positions, with distinct labels.
#[tokio::test]
async fn self_join_returns_both_sides() {
    let srv = TestServer::spawn().await;
    let body = ok_body(&srv, &self_join(), &[("limit", "5".into())]).await;
    let left = label(&body, 0, "id");
    let right = label(&body, 1, "id");
    assert_ne!(left, right, "self-join labels must differ");
    assert_exact(rows(&body).len(), 5, "rows");
    for row in rows(&body) {
        assert!(row[&left].is_string() && row[&right].is_string(), "{row}");
    }
}

/// P5.11-COLUMNS: `columns` selects and orders the output.
#[tokio::test]
async fn columns_selects_and_orders_the_output() {
    let srv = TestServer::spawn().await;
    let mut join = orders_users("left");
    join["columns"] = json!([{"join": 1, "column": "email"}, {"join": 0, "column": "id"}]);
    let body = ok_body(&srv, &join, &[("limit", "2".into())]).await;
    let order: Vec<(&str, &str)> = body["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["table"].as_str().unwrap(), c["column"].as_str().unwrap()))
        .collect();
    assert_exact(
        order,
        vec![("users", "email"), ("orders", "id")],
        "column order",
    );
}

/// P5.11-FILTER-JOINED: a condition's `join` selects the table its column
/// belongs to; the text-cast comparison applies to that column.
#[tokio::test]
async fn filter_on_a_joined_table_column() {
    let srv = TestServer::spawn().await;
    let order = data(&srv, "orders", &[("limit", "1".into())]).await;
    let user_id = order["rows"][0]["user_id"].as_str().unwrap().to_string();
    let user = data(
        &srv,
        "users",
        &[(
            "filter",
            json!([{"column": "id", "op": "=", "value": user_id}]).to_string(),
        )],
    )
    .await;
    let email = user["rows"][0]["email"].as_str().unwrap().to_string();

    let mut join = orders_users("inner");
    join["columns"] = json!([{"join": 0, "column": "id"}, {"join": 1, "column": "email"}]);
    let filter = json!([{"join": 1, "column": "email", "op": "=", "value": email}]);
    let body = ok_body(&srv, &join, &[("filter", filter.to_string())]).await;
    let email_label = label(&body, 1, "email");
    assert!(!rows(&body).is_empty(), "the user has at least one order");
    assert!(
        rows(&body).iter().all(|r| r[&email_label] == json!(email)),
        "{body:#?}"
    );
}

/// P5.11-SORT: `sort` + `sort_join` order by the column at that position;
/// `desc` reverses it.
#[tokio::test]
async fn sort_applies_to_the_table_at_sort_join() {
    let srv = TestServer::spawn().await;
    let mut join = orders_users("inner");
    join["columns"] = json!([{"join": 0, "column": "id"}, {"join": 1, "column": "email"}]);
    for (sort_join, column, table) in [(0, "id", 0), (1, "email", 1)] {
        let first = |order: &'static str| {
            let join = join.clone();
            let srv = &srv;
            async move {
                let body = ok_body(
                    srv,
                    &join,
                    &[
                        ("sort", column.to_string()),
                        ("sort_join", sort_join.to_string()),
                        ("order", order.to_string()),
                        ("limit", "1".into()),
                    ],
                )
                .await;
                let name = label(&body, table, column);
                rows(&body)[0][&name].clone()
            }
        };
        assert_ne!(
            first("asc").await,
            first("desc").await,
            "sort on position {sort_join} must change the order"
        );
    }
}

/// P5.11-HAS-MORE: true when a following row exists, false on the last
/// page; `limit` is clamped, never rejected.
#[tokio::test]
async fn has_more_reports_a_following_row() {
    let srv = TestServer::spawn().await;
    let join = orders_users("left");

    let first = ok_body(&srv, &join, &[("limit", "1".into())]).await;
    assert_exact(
        first["has_more"].clone(),
        json!(true),
        "has_more with a next row",
    );
    assert_exact(rows(&first).len(), 1, "rows");

    let clamped = ok_body(&srv, &join, &[("limit", "0".into())]).await;
    assert_exact(rows(&clamped).len(), 1, "limit=0 clamps to 1");

    let beyond = ok_body(&srv, &join, &[("offset", "1000000000".into())]).await;
    assert_exact(rows(&beyond).len(), 0, "offset beyond the end");
    assert_exact(
        beyond["has_more"].clone(),
        json!(false),
        "has_more past the end",
    );

    // A filtered set small enough for one page: has_more flips exactly at its size.
    let mut one = orders_users("inner");
    one["columns"] = json!([{"join": 0, "column": "id"}]);
    let order = data(&srv, "orders", &[("limit", "1".into())]).await;
    let user_id = order["rows"][0]["user_id"].as_str().unwrap().to_string();
    let filter = json!([{"join": 0, "column": "user_id", "op": "=", "value": user_id}]);
    let page = ok_body(
        &srv,
        &one,
        &[("filter", filter.to_string()), ("limit", "100".into())],
    )
    .await;
    let n = rows(&page).len();
    if n > 0 && n < 100 {
        assert_exact(page["has_more"].clone(), json!(false), "last page");
        let exact = ok_body(
            &srv,
            &one,
            &[("filter", filter.to_string()), ("limit", n.to_string())],
        )
        .await;
        assert_exact(
            exact["has_more"].clone(),
            json!(false),
            "page that exactly fits",
        );
        if n > 1 {
            let short = ok_body(
                &srv,
                &one,
                &[
                    ("filter", filter.to_string()),
                    ("limit", (n - 1).to_string()),
                ],
            )
            .await;
            assert_exact(short["has_more"].clone(), json!(true), "page one row short");
        }
    }
}

/// P5.11-SCHEMA-PARAM / P5.11-SOURCE-PARAM: an explicit default schema
/// resolves like an absent one; an unrecognized `source`/`schema` is a 400.
#[tokio::test]
async fn source_and_schema_params_resolve_like_the_other_routes() {
    let srv = TestServer::spawn().await;
    let join = orders_users("left");
    let args = [("sort", "id".to_string()), ("limit", "5".into())];
    let implicit = ok_body(&srv, &join, &args).await;
    let mut explicit_args = args.to_vec();
    explicit_args.push(("schema", Backend::current().default_schema()));
    let explicit = ok_body(&srv, &join, &explicit_args).await;
    assert_exact(
        explicit["rows"].clone(),
        implicit["rows"].clone(),
        "explicit default schema",
    );

    for (param, what) in [("schema", "unknown schema"), ("source", "unknown source")] {
        let resp = get_join(&srv, &join, &[(param, "no_such_name".into())]).await;
        assert_status(&resp, 400, what);
    }
}

/// P5.11-SCHEMA-ISOLATION: every table resolves in the resolved schema only.
#[tokio::test]
async fn tables_resolve_only_in_the_requested_schema() {
    let srv = TestServer::spawn().await;
    if matches!(Backend::current().schema_model(), SchemaModel::Single) {
        return;
    }
    let resp = get_join(
        &srv,
        &orders_users("left"),
        &[("schema", "other_schema".into())],
    )
    .await;
    assert_problem_code(resp, 400, "unknown_table", "orders is not in other_schema").await;
}

/// P5.11-TABLE-COLUMN-EXACT: unknown or injection-shaped names are 400,
/// never spliced.
#[tokio::test]
async fn unknown_and_malicious_names_are_rejected() {
    let srv = TestServer::spawn().await;
    let hostile = [
        "no_such_table",
        "orders\"; drop table users; --",
        "orders'",
        "Orders",
        "orders\u{0}",
        "users u",
    ];
    for name in hostile {
        let mut base = orders_users("left");
        base["table"] = json!(name);
        let resp = get_join(&srv, &base, &[]).await;
        assert_problem_code(resp, 400, "unknown_table", &format!("base table {name:?}")).await;

        let mut joined = orders_users("left");
        joined["joins"][0]["table"] = json!(name);
        let resp = get_join(&srv, &joined, &[]).await;
        assert_problem_code(
            resp,
            400,
            "unknown_table",
            &format!("joined table {name:?}"),
        )
        .await;

        let mut right = orders_users("left");
        right["joins"][0]["on"][0]["right"] = json!(name);
        let resp = get_join(&srv, &right, &[]).await;
        assert_problem_code(resp, 400, "unknown_column", &format!("on.right {name:?}")).await;

        let mut left = orders_users("left");
        left["joins"][0]["on"][0]["left"]["column"] = json!(name);
        let resp = get_join(&srv, &left, &[]).await;
        assert_problem_code(resp, 400, "unknown_column", &format!("on.left {name:?}")).await;

        let mut cols = orders_users("left");
        cols["columns"] = json!([{"join": 0, "column": name}]);
        let resp = get_join(&srv, &cols, &[]).await;
        assert_problem_code(resp, 400, "unknown_column", &format!("columns {name:?}")).await;

        let resp = get_join(&srv, &orders_users("left"), &[("sort", name.to_string())]).await;
        assert_problem_code(resp, 400, "unknown_column", &format!("sort {name:?}")).await;

        let filter = json!([{"column": name, "op": "=", "value": "x"}]);
        let resp = get_join(
            &srv,
            &orders_users("left"),
            &[("filter", filter.to_string())],
        )
        .await;
        assert_problem_code(resp, 400, "unknown_column", &format!("filter {name:?}")).await;
    }
}

/// P5.11-ON-RULES: positions, pair count, equality-only shape, join type.
#[tokio::test]
async fn invalid_join_structures_are_rejected() {
    let srv = TestServer::spawn().await;
    let pair = json!({"left": {"join": 0, "column": "id"}, "right": "order_id"});

    let mut forward = orders_extra("left");
    forward["joins"][0]["on"][0]["left"]["join"] = json!(1);
    let mut later = orders_extra("left");
    later["joins"][0]["on"][0]["left"]["join"] = json!(2);
    let mut four_pairs = orders_extra("left");
    four_pairs["joins"][0]["on"] = json!([pair, pair, pair, pair]);
    let mut no_pairs = orders_extra("left");
    no_pairs["joins"][0]["on"] = json!([]);
    let mut right_type = orders_extra("left");
    right_type["joins"][0]["type"] = json!("right");
    let mut upper_type = orders_extra("left");
    upper_type["joins"][0]["type"] = json!("LEFT");
    let mut operator = orders_extra("left");
    operator["joins"][0]["on"][0]["op"] = json!(">");
    let mut no_joins = orders_extra("left");
    no_joins["joins"] = json!([]);
    let mut empty_columns = orders_extra("left");
    empty_columns["columns"] = json!([]);
    let mut dup_columns = orders_extra("left");
    dup_columns["columns"] = json!([{"join": 0, "column": "id"}, {"join": 0, "column": "id"}]);
    let mut bad_column_join = orders_extra("left");
    bad_column_join["columns"] = json!([{"join": 5, "column": "id"}]);
    let entry = orders_extra("left")["joins"][0].clone();
    let mut five_tables = orders_extra("left");
    five_tables["joins"] = json!([entry, entry, entry, entry]);

    let cases = [
        ("on.left refers to its own position", forward),
        ("on.left refers to a later position", later),
        ("4 pairs", four_pairs),
        ("no pairs", no_pairs),
        ("type right", right_type),
        ("type LEFT is not lowercase", upper_type),
        ("operator key", operator),
        ("no joins", no_joins),
        ("empty columns", empty_columns),
        ("duplicate columns", dup_columns),
        ("columns position out of range", bad_column_join),
        ("5 tables", five_tables),
    ];
    for (what, join) in cases {
        let resp = get_join(&srv, &join, &[]).await;
        assert_problem_code(resp, 400, "invalid_parameter", what).await;
    }

    for raw in [
        "not json",
        "[]",
        "\"orders\"",
        "{}",
        "{\"table\":\"orders\"}",
    ] {
        let resp = srv
            .client()
            .get(srv.url("/api/tables/join"))
            .query(&[("join", raw)])
            .send()
            .await
            .unwrap();
        assert_status(&resp, 400, &format!("join={raw}"));
    }
    let resp = srv
        .client()
        .get(srv.url("/api/tables/join"))
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "join is required");
}

/// P5.11-JOIN-BOUND: an oversize `join` is a 400, never truncated.
#[tokio::test]
async fn oversize_join_is_rejected() {
    let srv = TestServer::spawn().await;
    let mut join = orders_users("left");
    join["table"] = json!("t".repeat(9000));
    let resp = get_join(&srv, &join, &[]).await;
    assert_status(&resp, 400, "join over 8192 bytes");
}

/// P5.11-COMPATIBILITY: a pair across classes is a 400 `invalid_parameter`;
/// `json`/`jsonb` columns are never joinable.
#[tokio::test]
async fn incompatible_column_pairs_are_rejected() {
    let srv = TestServer::spawn().await;
    let mut cross = orders_users("left");
    cross["joins"][0]["on"][0]["left"]["column"] = json!("status");
    let resp = get_join(&srv, &cross, &[]).await;
    assert_problem_code(resp, 400, "invalid_parameter", "orders.status to users.id").await;

    match Backend::current().not_joinable_columns() {
        NotJoinableColumns::Seeded => {
            let json_pair = json!({
                "table": "users",
                "joins": [{
                    "type": "inner", "table": "users",
                    "on": [{"left": {"join": 0, "column": "metadata"}, "right": "metadata"}]
                }]
            });
            let resp = get_join(&srv, &json_pair, &[]).await;
            assert_problem_code(resp, 400, "invalid_parameter", "json to json").await;
        }
        NotJoinableColumns::NotSeeded => {}
    }
}

/// P5.11-COMPATIBLE-NUMBERS: an exact numeric pair joins even when the
/// native types differ in width.
#[tokio::test]
async fn same_class_pairs_with_different_types_join() {
    let srv = TestServer::spawn().await;
    let join = json!({
        "table": "orders",
        "joins": [{
            "type": "inner", "table": "orders",
            "on": [{"left": {"join": 0, "column": "total_cents"}, "right": "total_cents"}]
        }],
        "columns": [{"join": 0, "column": "id"}]
    });
    let resp = get_join(&srv, &join, &[("limit", "1".into())]).await;
    assert_status(&resp, 200, "number to number");
}

/// P5.11-SORT-PARAMS: `sort_join` needs `sort` and a real position;
/// `order` is validated.
#[tokio::test]
async fn sort_parameters_are_validated() {
    let srv = TestServer::spawn().await;
    let join = orders_users("left");
    let cases: [(&str, Vec<(&str, String)>); 4] = [
        ("sort_join without sort", vec![("sort_join", "1".into())]),
        (
            "sort_join out of range",
            vec![("sort", "id".into()), ("sort_join", "2".into())],
        ),
        (
            "sort column not in the table at sort_join",
            vec![("sort", "email".into()), ("sort_join", "0".into())],
        ),
        (
            "bad order",
            vec![("sort", "id".into()), ("order", "sideways".into())],
        ),
    ];
    for (what, args) in cases {
        let resp = get_join(&srv, &join, &args).await;
        assert_status(&resp, 400, what);
    }
}

/// P5.11-FILTER-RULES: `join` positions are range-checked; the §5.4.2
/// structural rules still apply; §5.4 rejects a `join` key.
#[tokio::test]
async fn filter_rules_hold_on_the_join_route() {
    let srv = TestServer::spawn().await;
    let join = orders_users("left");
    let out_of_range = json!([{"join": 2, "column": "id", "op": "IS NOT NULL"}]);
    let resp = get_join(&srv, &join, &[("filter", out_of_range.to_string())]).await;
    assert_problem_code(resp, 400, "invalid_filter", "join position out of range").await;

    let wrong_table = json!([{"join": 0, "column": "email", "op": "IS NOT NULL"}]);
    let resp = get_join(&srv, &join, &[("filter", wrong_table.to_string())]).await;
    assert_status(&resp, 400, "email is not a column of orders");

    let eleven: Vec<Value> = (0..11)
        .map(|i| {
            let mut c = json!({"column": "id", "op": "IS NOT NULL"});
            if i > 0 {
                c["logic"] = json!("AND");
            }
            c
        })
        .collect();
    let resp = get_join(&srv, &join, &[("filter", json!(eleven).to_string())]).await;
    assert_status(&resp, 400, "11 conditions");

    let resp = get_join(&srv, &join, &[("filter", "status = completed".into())]).await;
    assert_problem_code(resp, 400, "invalid_filter", "DSL text").await;

    let with_join = json!([{"join": 0, "column": "id", "op": "IS NOT NULL"}]);
    let resp = srv
        .client()
        .get(srv.url("/api/tables/data"))
        .query(&[("table", "orders"), ("filter", &with_join.to_string())])
        .send()
        .await
        .unwrap();
    assert_problem_code(
        resp,
        400,
        "invalid_filter",
        "/tables/data rejects a join key",
    )
    .await;

    let empty = ok_body(
        &srv,
        &join,
        &[("filter", "[]".into()), ("limit", "1".into())],
    )
    .await;
    assert_exact(rows(&empty).len(), 1, "empty filter array means no filter");
}

/// P5.11-HEADER: the protocol version header is on 200 and 400.
#[tokio::test]
async fn every_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    let ok = get_join(&srv, &orders_users("left"), &[("limit", "1".into())]).await;
    let bad = get_join(&srv, &json!({"table": "no_such_table", "joins": []}), &[]).await;
    for (resp, what) in [(ok, "200"), (bad, "400")] {
        assert_exact(
            resp.headers()
                .get("x-ashurbanipal-protocol")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
            Some("1".to_string()),
            &format!("protocol header on {what}"),
        );
    }
}
