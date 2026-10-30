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

async fn fetch_page(srv: &TestServer, accept_encoding: Option<&str>) -> reqwest::Response {
    let mut req = srv.client().get(srv.url(""));
    if let Some(value) = accept_encoding {
        req = req.header("accept-encoding", value);
    }
    let resp = req.send().await.unwrap();
    assert_status(&resp, 200, "GET {mount}");
    resp
}

fn header_values(resp: &reqwest::Response, name: &str) -> Vec<String> {
    resp.headers()
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_ascii_lowercase())
        .collect()
}

#[tokio::test]
async fn page_is_gzipped_when_accepted_and_decodes_to_the_same_bytes() {
    use std::io::Read;

    let srv = TestServer::spawn().await;
    let plain = fetch_page(&srv, None).await;
    assert!(
        plain.headers().get("content-encoding").is_none(),
        "a request without Accept-Encoding got a compressed page"
    );
    let plain = plain.bytes().await.unwrap();

    let gzipped = fetch_page(&srv, Some("gzip")).await;
    assert_eq!(
        header_values(&gzipped, "content-encoding"),
        ["gzip"],
        "Accept-Encoding: gzip must get a gzip page"
    );
    assert!(
        header_values(&gzipped, "vary")
            .iter()
            .any(|v| v == "accept-encoding"),
        "a compressed page must carry Vary: Accept-Encoding"
    );
    let compressed = gzipped.bytes().await.unwrap();
    assert!(
        compressed.len() < plain.len() / 2,
        "the gzip page is not smaller"
    );
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(&compressed[..])
        .read_to_end(&mut decoded)
        .expect("the gzip page does not decode");
    assert!(
        decoded == plain,
        "the decoded gzip page differs from the uncompressed page"
    );
}

#[tokio::test]
async fn page_is_not_gzipped_when_gzip_has_q_zero() {
    let srv = TestServer::spawn().await;
    let resp = fetch_page(&srv, Some("gzip;q=0")).await;
    assert!(
        resp.headers().get("content-encoding").is_none(),
        "Accept-Encoding: gzip;q=0 got a compressed page"
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
    // A target started for labelled_siblings.rs reports its fixed config instead.
    if body.get("instance").is_some_and(|v| !v.is_null()) {
        eprintln!("siblings_endpoint_returns_empty_list_by_default: skipping — target has an instance configured");
        return;
    }
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
