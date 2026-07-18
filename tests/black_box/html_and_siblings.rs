use crate::common::TestServer;

#[tokio::test]
async fn root_serves_the_embedded_dbviewer_html() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
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
async fn siblings_endpoint_returns_empty_list_by_default() {
    let srv = TestServer::spawn().await;
    let body: serde_json::Value = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/siblings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body, serde_json::json!({"siblings": []}));
}
