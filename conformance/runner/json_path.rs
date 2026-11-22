//! A condition's `path` into a JSON column (`spec/protocol.md` §5.4.2),
//! asserted by the rows it returns from the seed's `json_docs` table. The
//! seed rows are the same on every engine, except that SQLite's row 6 is
//! not valid JSON and the others hold the JSON string `"not json"`; no path
//! yields a value from row 6 on any engine.

use serde_json::{json, Value};

use crate::assert::assert_problem_code;
use crate::backend::Backend;
use crate::common::TestServer;
use crate::filter_dsl::{fetch, ids};
use crate::join::{ok_body, rows};

/// The `id`s of the `json_docs` rows `filter` returns, in id order.
async fn doc_ids(srv: &TestServer, filter: Value) -> Vec<String> {
    ids(srv, "json_docs", &filter).await
}

fn path(path: Value, op: &str, value: Option<Value>) -> Value {
    let mut c = json!({"column": "doc", "path": path, "op": op});
    if let Some(v) = value {
        c["value"] = v;
    }
    json!([c])
}

#[tokio::test]
async fn a_path_reads_the_value_at_that_key() {
    let srv = TestServer::spawn().await;
    let eq = |p: Value, v: &str| path(p, "=", Some(json!(v)));
    assert_eq!(doc_ids(&srv, eq(json!(["status"]), "failed")).await, ["1"]);
    assert_eq!(doc_ids(&srv, eq(json!(["nested", "k"]), "V")).await, ["1"]);
    assert_eq!(
        doc_ids(&srv, eq(json!(["arr", 0, "user id"]), "42")).await,
        ["1"],
        "a key, an index, then a key holding a space"
    );
    assert_eq!(doc_ids(&srv, eq(json!(["n"]), "10")).await, ["1"]);
    assert_eq!(
        doc_ids(&srv, eq(json!(["arr", "0", "user id"]), "42")).await,
        Vec::<String>::new(),
        "the key \"0\" is not the index 0"
    );
}

#[tokio::test]
async fn keys_that_mean_something_in_a_path_language_are_read_literally() {
    let srv = TestServer::spawn().await;
    for (key, value) in [
        ("a.b", "dot"),
        ("a b", "space"),
        ("*", "star"),
        ("ü", "umlaut"),
    ] {
        assert_eq!(
            doc_ids(&srv, path(json!([key]), "=", Some(json!(value)))).await,
            ["1"],
            "key {key:?}"
        );
    }
    assert_eq!(
        doc_ids(&srv, path(json!(["*"]), "IS NOT NULL", None)).await,
        ["1"],
        "the key \"*\" must not act as a wildcard over the other rows' keys"
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["' OR 1=1 --"]), "IS NOT NULL", None)).await,
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn missing_keys_json_null_and_sql_null_are_all_null() {
    let srv = TestServer::spawn().await;
    assert_eq!(
        doc_ids(&srv, path(json!(["status"]), "IS NULL", None)).await,
        ["3", "4", "5", "6"],
        "3: JSON null, 4: missing key, 5: SQL NULL, 6: not an object"
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["nested"]), "IS NULL", None)).await,
        ["2", "3", "4", "5", "6"]
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["status"]), "IS NOT NULL", None)).await,
        ["1", "2"]
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["status"]), "!=", Some(json!("failed")))).await,
        ["2"],
        "!= drops the NULL rows, as for any column"
    );
    let not_eq =
        json!([{"not": true, "column": "doc", "path": ["status"], "op": "=", "value": "failed"}]);
    assert_eq!(doc_ids(&srv, not_eq).await, ["2"]);
    assert_eq!(
        doc_ids(&srv, path(json!(["arr", 5]), "IS NULL", None)).await,
        ["1", "2", "3", "4", "5", "6"],
        "an index past the end"
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["status", "x"]), "IS NULL", None)).await,
        ["1", "2", "3", "4", "5", "6"],
        "a key step into a string"
    );
}

#[tokio::test]
async fn values_compare_as_case_sensitive_text() {
    let srv = TestServer::spawn().await;
    let p = |op: &str, v: Value| path(json!(["status"]), op, Some(v));
    assert_eq!(doc_ids(&srv, p("=", json!("FAILED"))).await, ["2"]);
    assert_eq!(doc_ids(&srv, p("IN", json!(["failed", "x"]))).await, ["1"]);
    assert_eq!(doc_ids(&srv, p("ILIKE", json!("failed"))).await, ["1", "2"]);
    assert_eq!(
        doc_ids(
            &srv,
            path(json!(["n"]), "BETWEEN", Some(json!(["10", "9"])))
        )
        .await,
        ["1", "2"],
        "as text, \"10\" sorts before \"9\""
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["n"]), ">", Some(json!("9")))).await,
        Vec::<String>::new(),
        "as text, \"10\" is not above \"9\""
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["price"]), "LIKE", Some(json!("1.5%")))).await,
        ["1"]
    );
    assert_eq!(
        doc_ids(&srv, path(json!(["nested"]), "LIKE", Some(json!("%V%")))).await,
        ["1"],
        "an object leaf compares as its JSON text"
    );
}

#[tokio::test]
async fn booleans_compare_as_true_and_false() {
    let srv = TestServer::spawn().await;
    let flag = |v: &str| path(json!(["flag"]), "=", Some(json!(v)));
    assert_eq!(doc_ids(&srv, flag("true")).await, ["1"]);
    assert_eq!(doc_ids(&srv, flag("false")).await, ["2"]);
    assert_eq!(doc_ids(&srv, flag("1")).await, Vec::<String>::new());
}

#[tokio::test]
async fn json_and_jsonb_columns_read_the_same() {
    let srv = TestServer::spawn().await;
    if Backend::current() != Backend::Postgres {
        return;
    }
    let filter =
        json!([{"column": "doc_json", "path": ["arr", 0, "user id"], "op": "=", "value": "42"}]);
    assert_eq!(doc_ids(&srv, filter).await, ["1"]);
}

#[tokio::test]
async fn a_path_on_a_column_that_is_not_json_is_invalid_filter() {
    let srv = TestServer::spawn().await;
    let filter = json!([{"column": "email", "path": ["domain"], "op": "=", "value": "x"}]);
    let resp = fetch(&srv, "users", &filter.to_string()).await;
    assert_problem_code(resp, 400, "invalid_filter", "path on users.email").await;
}

#[tokio::test]
async fn a_bad_path_is_invalid_filter() {
    let srv = TestServer::spawn().await;
    for bad in [
        json!([]),
        json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
        json!([-1]),
        json!([1.5]),
        json!(["say \"hi\""]),
        json!(["a\u{1}"]),
        json!([""]),
    ] {
        let resp = fetch(
            &srv,
            "json_docs",
            &path(bad.clone(), "=", Some(json!("x"))).to_string(),
        )
        .await;
        assert_problem_code(resp, 400, "invalid_filter", &format!("path {bad}")).await;
    }
}

#[tokio::test]
async fn the_join_route_takes_a_path_on_a_joined_table() {
    let srv = TestServer::spawn().await;
    let join = json!({
        "table": "json_docs",
        "joins": [{"type": "inner", "table": "json_docs", "on": [{"left": {"join": 0, "column": "id"}, "right": "id"}]}],
        "columns": [{"join": 0, "column": "id"}]
    });
    let filter =
        json!([{"join": 1, "column": "doc", "path": ["status"], "op": "=", "value": "FAILED"}]);
    let body = ok_body(&srv, &join, &[("filter", filter.to_string())]).await;
    let rows = rows(&body);
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["id"], json!("2"), "{body}");
}
