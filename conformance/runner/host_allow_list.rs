//! `spec/protocol.md` §3.1 — the optional `Host` allow-list. CI starts each
//! port's demo with `CONFORMANCE_ALLOWED_HOSTS=1` (Spring: profile
//! `conformance-allowed-hosts`), which every port maps to
//! `allowed_hosts = ["localhost", "127.0.0.1"]`; the spawned Rust demo always
//! gets it. Against an external target each test skips when an unlisted
//! `Host` is served, and fails instead under `CONFORMANCE_EXPECT_HOST_CHECK`,
//! which CI sets.

use reqwest::StatusCode;

use crate::common::TestServer;

const UNLISTED: &str = "rebind.invalid";

/// Every route under the mount. The check runs before any parameter is
/// read, so these need not be valid.
const ROUTES: &[&str] = &[
    "",
    "/api/sources",
    "/api/schemas",
    "/api/tables",
    "/api/table-counts",
    "/api/tables/data?table=users",
    "/api/tables/common-values?table=users&column=email",
    "/api/tables/referenced-by?table=users",
    "/api/tables/structure?table=users",
    "/api/tables/join",
    "/api/siblings",
];

async fn get(srv: &TestServer, path: &str, headers: &[(&str, &str)]) -> StatusCode {
    let mut req = srv.client().get(srv.url(path));
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    req.send().await.unwrap().status()
}

/// `false` when the target serves an unlisted `Host`, so the check is off.
async fn host_check_is_on(srv: &TestServer) -> bool {
    let status = get(srv, "", &[("host", UNLISTED)]).await;
    if status == StatusCode::NOT_FOUND {
        return true;
    }
    assert!(
        std::env::var_os("CONFORMANCE_EXPECT_HOST_CHECK").is_none(),
        "Host: {UNLISTED} got {status}, expected 404 from a target started with \
         allowed_hosts = [\"localhost\", \"127.0.0.1\"] (spec/protocol.md §3.1)"
    );
    eprintln!(
        "host_allow_list: skipping — Host: {UNLISTED} got {status}; start the target with \
         CONFORMANCE_ALLOWED_HOSTS=1 to exercise this check"
    );
    false
}

#[tokio::test]
async fn an_unlisted_host_gets_404_on_every_route() {
    let srv = TestServer::spawn().await;
    if !host_check_is_on(&srv).await {
        return;
    }
    for path in ROUTES {
        assert_eq!(
            get(&srv, path, &[("host", UNLISTED)]).await,
            StatusCode::NOT_FOUND,
            "GET {path} with Host: {UNLISTED}"
        );
    }
}

#[tokio::test]
async fn forwarded_headers_do_not_pass_the_check() {
    let srv = TestServer::spawn().await;
    if !host_check_is_on(&srv).await {
        return;
    }
    let headers = [
        ("host", UNLISTED),
        ("x-forwarded-host", "localhost"),
        ("forwarded", "host=localhost"),
    ];
    for path in ["", "/api/tables"] {
        assert_eq!(
            get(&srv, path, &headers).await,
            StatusCode::NOT_FOUND,
            "GET {path} with Host: {UNLISTED} and forwarded headers naming localhost"
        );
    }
}

#[tokio::test]
async fn a_listed_name_passes_in_any_case_and_on_any_port() {
    let srv = TestServer::spawn().await;
    if !host_check_is_on(&srv).await {
        return;
    }
    for host in ["LOCALHOST", "localhost:1", "127.0.0.1:65535"] {
        for path in ["", "/api/tables"] {
            assert_eq!(
                get(&srv, path, &[("host", host)]).await,
                StatusCode::OK,
                "GET {path} with Host: {host}"
            );
        }
    }
}

/// `spec/protocol.md` §3: the check never touches a host route. Probes the
/// demo's own `GET /health` at the origin; a target without one skips.
#[tokio::test]
async fn a_host_route_answers_an_unlisted_host() {
    let srv = TestServer::spawn().await;
    if !host_check_is_on(&srv).await {
        return;
    }
    let mut health = reqwest::Url::parse(&srv.url("")).unwrap();
    health.set_path("/health");
    health.set_query(None);
    let listed = srv.client().get(health.clone()).send().await.unwrap();
    if listed.status() != StatusCode::OK {
        eprintln!(
            "host_allow_list: skipping the host-route probe — GET {health} got {}",
            listed.status()
        );
        return;
    }
    let listed_body = listed.text().await.unwrap();
    let unlisted = srv
        .client()
        .get(health.clone())
        .header("host", UNLISTED)
        .send()
        .await
        .unwrap();
    assert_eq!(
        unlisted.status(),
        StatusCode::OK,
        "GET {health} with Host: {UNLISTED} is a host route the check must not touch"
    );
    assert_eq!(
        unlisted.text().await.unwrap(),
        listed_body,
        "GET {health} body"
    );
}
