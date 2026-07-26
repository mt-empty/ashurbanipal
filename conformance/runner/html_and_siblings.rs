use crate::assert::{assert_exact, assert_status};
use crate::common::TestServer;

#[tokio::test]
async fn root_serves_the_embedded_dbviewer_html() {
    let srv = TestServer::spawn().await;
    let resp = srv.client().get(srv.url("")).send().await.unwrap();
    assert_status(&resp, 200, "GET {mount}");
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.contains("text/html"),
        "unexpected content-type: {content_type}"
    );
    let body = resp.text().await.unwrap();
    assert!(
        body.contains(r#"id="tables""#),
        "expected the embedded dbviewer.html to contain the #tables element"
    );
}

#[tokio::test]
async fn dbviewer_html_does_not_hardcode_the_api_base() {
    let srv = TestServer::spawn().await;
    let body = srv
        .client()
        .get(srv.url(""))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    // The frontend must derive its API base from location.pathname so the UI
    // works behind any reverse-proxy prefix (spec/protocol.md §3); a literal
    // base for *this* server's own mount would break that. Built from the
    // server's actual mount root (not a hardcoded "/__ashurbanipal") so this
    // check is meaningful against an external target mounted elsewhere too.
    let literal_base = format!("\"{}/api\"", srv.url(""));
    assert!(
        !body.contains(&literal_base),
        "dbviewer.html hardcodes its own API base ({literal_base})"
    );
}

#[tokio::test]
async fn siblings_endpoint_returns_empty_list_by_default() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/api/siblings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_exact(
        body,
        serde_json::json!({"siblings": []}),
        "GET /api/siblings",
    );
}

/// spec/protocol.md §3: implementations MUST NOT expose additional
/// endpoints under `{mount}` — a made-up path under the mount must 404
/// exactly like any other unknown route, not fall through to some other
/// handler.
#[tokio::test]
async fn unknown_path_under_mount_is_404() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/not-a-real-route"))
        .send()
        .await
        .unwrap();
    assert_status(&resp, 404, "GET {mount}/api/not-a-real-route");
}
