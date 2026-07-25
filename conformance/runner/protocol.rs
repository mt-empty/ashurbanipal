use crate::assert::{assert_exact, assert_status};
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
        "/api/tables",
        "/api/table-counts",
        "/api/tables/data?table=users",
        "/api/tables/common-values?table=users&column=is_active",
        "/api/siblings",
    ];
    for path in api_paths {
        let resp = srv.client().get(srv.url(path)).send().await.unwrap();
        assert!(resp.status().is_success(), "{path}: {}", resp.status());
        assert_exact(
            header_value(&resp),
            Some("1"),
            &format!("{PROTOCOL_HEADER} on {path}"),
        );
        // spec/protocol.md §6: statelessness — no server-side session is
        // required, and the reference never sets one; a Set-Cookie here
        // would signal a stateful implementation the protocol doesn't ask
        // for and clients aren't obliged to carry.
        assert!(
            !resp.headers().contains_key("set-cookie"),
            "{path}: unexpected Set-Cookie (spec/protocol.md §6 statelessness)"
        );
    }
}

#[tokio::test]
async fn protocol_header_is_present_even_on_api_error_responses() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/api/tables/data?table=no_such_table"))
        .send()
        .await
        .unwrap();
    assert_status(&resp, 400, "table=no_such_table");
    assert_exact(header_value(&resp), Some("1"), PROTOCOL_HEADER);
}

/// spec/protocol.md §2/§6: the protocol is read-only — every route is
/// `GET`, and implementations MUST NOT accept writes of any kind. A POST to
/// a real API path must not be treated as one; Axum's own routing already
/// guarantees this (route table only registers `get()` handlers), but the
/// point of this suite is verifying the behavior over HTTP, not trusting
/// the router configuration by inspection.
#[tokio::test]
async fn writes_are_not_accepted() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .post(srv.url("/api/tables"))
        .send()
        .await
        .unwrap();
    assert!(
        !resp.status().is_success(),
        "POST {{mount}}/api/tables should not succeed, got {}",
        resp.status()
    );
}
