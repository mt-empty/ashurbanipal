//! Data-driven fixture transcribing every case from `docs/filter-dsl.md` §5
//! (V1-V15 valid, R1-R14 rejected, A1-A9 adversarial — 38 cases total).
//!
//! The filter DSL parser doesn't exist yet: `routes.rs` rejects any
//! non-empty `filter` value unconditionally with a stub 400. So today this
//! file can only assert that uniform stub behavior, not each case's
//! documented expected outcome. It's written now, against the doc's exact
//! inputs, so it flips to real per-case assertions once the parser lands
//! without a harness redesign.
//!
//! TODO(filter-dsl): flip each case to assert its documented outcome
//! (parsed triple for V*, 400 for R*, safe-parse-or-safe-reject for A*)
//! once the parser is implemented.

use crate::common::TestServer;

/// (case id, filter string). `R1` (empty string) is handled separately below
/// since it's the one case that's *not* rejected today — an empty/blank
/// filter is treated as "no filter", not a parse target.
fn static_cases() -> Vec<(&'static str, String)> {
    vec![
        // --- Valid (V1-V15) ---
        ("V1", "status = completed".to_string()),
        ("V2", "status=completed".to_string()),
        (
            "V3",
            "session_id = 18d852af-77ae-4a95-9f7d-e37a77fda2fd".to_string(),
        ),
        ("V4", "created_at > 2016-01-01".to_string()),
        ("V5", "a >= 1 AND b <= 2".to_string()),
        (
            "V6",
            "status = completed AND created_at > 2016-01-01 OR is_active = true".to_string(),
        ),
        ("V7", "name LIKE %smith%".to_string()),
        ("V8", "name LIKE '% smith%'".to_string()),
        ("V9", "note = 'it''s fine'".to_string()),
        ("V10", "deleted_at IS NULL".to_string()),
        ("V11", "deleted_at IS NOT NULL".to_string()),
        ("V12", "status = 'AND'".to_string()),
        ("V13", "a = 1 and b = 2 or c = 3".to_string()),
        ("V14", r#"payload = '{"a": 1}'"#.to_string()),
        ("V15", "email = ''".to_string()),
        // --- Rejected (R2-R14; R1 is the empty string, handled separately) ---
        ("R2", "status =".to_string()),
        ("R3", "= completed".to_string()),
        ("R4", "status == completed".to_string()),
        ("R5", "status = a AND".to_string()),
        ("R6", "(status = a)".to_string()),
        ("R7", "status = a; DROP TABLE users".to_string()),
        ("R8", "status = 'unterminated".to_string()),
        ("R9", "1abc = x".to_string()),
        ("R10", "status LIKE".to_string()),
        ("R11", "a = 1 OR OR b = 2".to_string()),
        ("R12", "NOT a = 1".to_string()),
        ("R13", "a = ".to_string() + &"x".repeat(1200)), // > 1 KiB
        ("R14", anded_conditions(11)),
        // --- Adversarial (A1-A9) ---
        ("A1", "status = '''; DROP TABLE users; --'".to_string()),
        ("A2", "id = 1 OR 1=1".to_string()),
        ("A3", "col\"name = x".to_string()),
        ("A4", "name LIKE '%'' OR ''1''=''1'".to_string()),
        ("A5", "status = \u{1D554}\u{1D560}\u{1D62C}\u{1D629}\u{1D5F5}\u{1D5F2}\u{1D629}\u{1D5F2}\u{1D5F1}".to_string()), // unicode confusables ("completed")
        ("A6", "\u{FF53}\u{FF54}\u{FF41}\u{FF54}\u{FF55}\u{FF53} = x".to_string()), // fullwidth "status"
        ("A7", "statu\0s = x".to_string()),                                        // embedded NUL byte
        ("A8", "pg_sleep = 1".to_string()), // column named after a SQL function; other doc variant is `users; --` as a column
        ("A9", anded_conditions(11)), // count-limit boundary; doc distinguishes exactly-10 (parses) vs 11 (rejects), collapsed here since both are 400 today
    ]
}

/// `n` ANDed `a = 1` conditions, e.g. `anded_conditions(2)` = `"a = 1 AND a = 1"`.
fn anded_conditions(n: usize) -> String {
    std::iter::repeat("a = 1")
        .take(n)
        .collect::<Vec<_>>()
        .join(" AND ")
}

const NOT_IMPLEMENTED_BODY: &str = "the `filter` parameter is not implemented yet";

#[tokio::test]
async fn every_non_empty_filter_dsl_case_gets_the_uniform_stub_400() {
    let srv = TestServer::spawn().await;
    for (id, filter) in static_cases() {
        let resp = srv
            .client()
            .get(srv.url("/__ashurbanipal/api/tables/data"))
            .query(&[("table", "users"), ("filter", &filter)])
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            400,
            "case {id} ({filter:?}) should currently 400 (parser not implemented)"
        );
        let body = resp.text().await.unwrap();
        assert_eq!(body, NOT_IMPLEMENTED_BODY, "case {id} unexpected body");
    }
}

#[tokio::test]
async fn r1_empty_filter_is_treated_as_no_filter_not_a_parse_error() {
    let srv = TestServer::spawn().await;
    let resp = srv
        .client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", "users"), ("filter", "")])
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "R1 (empty filter) should be treated as no filter, got {}",
        resp.status()
    );
}
