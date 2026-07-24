use crate::common::TestServer;

const PROTOCOL_HEADER: &str = "x-ashurbanipal-protocol";

fn header_value(resp: &reqwest::Response) -> Option<&str> {
    resp.headers()
        .get(PROTOCOL_HEADER)
        .and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn every_api_response_carries_the_protocol_version_header() {
    let srv = TestServer::spawn().await;
    let api_paths = [
        "/__ashurbanipal/api/tables",
        "/__ashurbanipal/api/table-counts",
        "/__ashurbanipal/api/tables/data?table=users",
        "/__ashurbanipal/api/tables/common-values?table=users&column=is_active",
        "/__ashurbanipal/api/siblings",
    ];
    for path in api_paths {
        let resp = srv.client().get(srv.url(path)).send().await.unwrap();
        assert!(resp.status().is_success(), "{path}: {}", resp.status());
        assert_eq!(
            header_value(&resp),
            Some("1"),
            "missing or wrong {PROTOCOL_HEADER} on {path}"
        );
    }
}

#[tokio::test]
async fn protocol_header_is_present_even_on_api_error_responses() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data?table=no_such_table"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    assert_eq!(header_value(&resp), Some("1"));
}
