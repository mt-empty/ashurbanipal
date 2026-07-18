//! Executable spec for the filter DSL, transcribing every case from
//! `docs/filter-dsl.md` §5 (V1-V21 valid, R1-R16 rejected, A1-A10
//! adversarial — 47 cases total) as its own named `#[tokio::test]`.
//!
//! The parser doesn't exist yet: `routes.rs` currently rejects any
//! non-empty `filter` value unconditionally with a stub 400
//! (`"the \`filter\` parameter is not implemented yet"`). Unlike a
//! version of this file that only checks today's uniform stub behavior,
//! every test below asserts the *documented* outcome for its case. That
//! means every "should succeed" case (all of V*, plus the "parses"-flavored
//! A-cases) is expected to fail right now — that's intentional. `cargo
//! test --test black_box` output is meant to be read as a per-case
//! red/green punch list for whoever implements the parser next; as each
//! case starts passing for real, its test goes green with no further
//! changes needed here.
//!
//! ## Table/column mapping notes (read before "fixing" a case)
//!
//! The doc's test table uses illustrative column names (`status`, `a`,
//! `b`, `note`, `deleted_at`, `session_id`, ...) without pinning them to a
//! specific table, since the doc is about the parser/grammar, not the
//! seeded demo schema. This suite runs against the real seeded tables
//! (`users`, `orders`, `products`, `events`, `sessions` — see
//! `.devcontainer/db/init/01-seed.sql`), and once the real parser lands,
//! a syntactically-valid filter against a column that *doesn't exist* on
//! the chosen table will correctly 400 at the schema allow-list stage
//! (same as A8/A10) — that's a different, later kind of rejection than
//! what a given "valid" case is trying to exercise. So for every V-case
//! and every "parses" A-case, the column referenced is a real column on
//! the table queried; where the doc's illustrative name doesn't exist
//! anywhere in the seed schema (`a`, `b`, `c`, `note`, `deleted_at`,
//! `session_id`, `name` used generically), it's swapped for a real
//! column that exercises the same grammar feature, noted case-by-case
//! below. Values are always safe to pick freely regardless of the
//! column's real Postgres type: per `filter-dsl.md` §3, the query builder
//! always does `column::text OP $n` with the value as an untyped bind
//! parameter — only the column is cast, so there's no type-mismatch risk
//! from e.g. comparing a `uuid` column against an arbitrary bare string.
//! Where it's cheap and the seed data (deterministic, fixed RNG seed —
//! see `tools/seed-gen`) makes a real assertion possible, tests also
//! check the returned `rows`, not just "not 400"; row counts referenced
//! below were confirmed directly against the live seeded devcontainer DB.
//!
//! R-cases and syntax-level-rejected A-cases don't need a real column at
//! all (the rejection happens during parsing, before the query builder
//! ever looks at the schema), so those keep the doc's placeholder names
//! (`a`, `b`, `status`, ...) unchanged.

use crate::common::TestServer;

/// GETs `/tables/data?table=...&filter=...` and returns the raw response.
async fn fetch(srv: &TestServer, table: &str, filter: &str) -> reqwest::Response {
    srv.client()
        .get(srv.url("/__ashurbanipal/api/tables/data"))
        .query(&[("table", table), ("filter", filter)])
        .send()
        .await
        .unwrap()
}

/// Asserts the filter is rejected with 400. Deliberately doesn't check the
/// response body: today's stub body is a placeholder, and the real parser
/// will give distinct per-case parse-error text (`filter-dsl.md` §4) —
/// pinning exact wording now would be presumptuous and brittle.
async fn assert_rejected(srv: &TestServer, case: &str, table: &str, filter: &str) {
    let resp = fetch(srv, table, filter).await;
    assert_eq!(
        resp.status(),
        400,
        "case {case} ({filter:?} against table {table:?}) should be rejected with 400"
    );
}

/// Asserts the filter is accepted (200) and returns the parsed JSON body.
/// This is the assertion that's false today for every valid/parses case —
/// the stub 400s everything, so this is exactly the guaranteed-red check.
async fn assert_accepted(
    srv: &TestServer,
    case: &str,
    table: &str,
    filter: &str,
) -> serde_json::Value {
    let resp = fetch(srv, table, filter).await;
    let status = resp.status();
    let body = resp.text().await.unwrap();
    assert_eq!(
        status, 200,
        "case {case} ({filter:?} against table {table:?}) should be accepted (200), got {status}: {body}"
    );
    serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("case {case} response wasn't valid JSON: {e}\nbody: {body}"))
}

/// `n` copies of `condition` ANDed together, e.g.
/// `anded_conditions(2, "a = 1")` = `"a = 1 AND a = 1"`.
fn anded_conditions(n: usize, condition: &str) -> String {
    std::iter::repeat(condition)
        .take(n)
        .collect::<Vec<_>>()
        .join(" AND ")
}

// ============================== Valid (V1-V21) ==============================

/// V1: `status = completed` -> `(status, =, "completed")`.
/// `orders.status` is a real enum column with 100/201 seeded rows
/// `= 'completed'`, so this also gets a content bonus check.
#[tokio::test]
async fn v1_basic_equality() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V1", "orders", "status = completed").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        !rows.is_empty(),
        "V1: expected at least one completed order"
    );
    for row in rows {
        assert_eq!(
            row["status"], "completed",
            "V1: row wasn't filtered to status=completed"
        );
    }
}

/// V2: `status=completed` — same as V1, no whitespace around the symbolic operator.
#[tokio::test]
async fn v2_no_space_symbolic_operator() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V2", "orders", "status=completed").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        !rows.is_empty(),
        "V2: expected at least one completed order"
    );
    for row in rows {
        assert_eq!(
            row["status"], "completed",
            "V2: row wasn't filtered to status=completed"
        );
    }
}

/// V3: uuid as a bare value. Doc uses illustrative column `session_id`,
/// which doesn't exist anywhere in the seed schema (the `sessions` table's
/// PK is `id`, not `session_id`) — swapped for `orders.user_id`, a real
/// uuid FK column, using a real seeded user id that has exactly 3 orders
/// (confirmed live: `select count(*) from orders where user_id = '8bc78ddc-...'`).
#[tokio::test]
async fn v3_uuid_bare_value() {
    let srv = TestServer::spawn().await;
    let uuid = "8bc78ddc-e82d-49be-8bbf-83708e726b4b";
    let body = assert_accepted(&srv, "V3", "orders", &format!("user_id = {uuid}")).await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        3,
        "V3: expected exactly 3 orders for this seeded user"
    );
    for row in rows {
        assert_eq!(row["user_id"], uuid);
    }
}

/// V4: `created_at > 2016-01-01` -> `(created_at, >, "2016-01-01")`.
/// Real column on `orders`; every seeded order is recent, so all 201 rows
/// match (confirmed live), meaning a default-limit page comes back full.
#[tokio::test]
async fn v4_greater_than_date() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V4", "orders", "created_at > 2016-01-01").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        50,
        "V4: expected a full default-size page (every order is recent)"
    );
}

/// V5: two ANDed conditions. Doc uses placeholder columns `a`/`b` —
/// swapped for real `orders` columns `total_cents`/`discount_pct`.
#[tokio::test]
async fn v5_two_conditions_and() {
    let srv = TestServer::spawn().await;
    assert_accepted(
        &srv,
        "V5",
        "orders",
        "total_cents >= 1 AND discount_pct <= 100",
    )
    .await;
}

/// V6: precedence — `A AND B OR C` groups as `(A AND B) OR C`. Doc's
/// illustrative shape mixes `status`/`created_at`/`is_active`, which don't
/// coexist on one real table; swapped for `products`, which really does
/// have an enum (`category`), a date (`created_on`), and a boolean
/// (`in_stock`) together — same 3-condition AND/OR shape as the doc.
///
/// A plain "not empty" check wouldn't actually exercise precedence here
/// (69/80 seeded products have `in_stock = true`, so the OR branch alone
/// makes the result non-empty regardless of how the query groups). The
/// real discriminator: seeded product `TOYS-1001` (category `toys`, so
/// the AND-clause is false) has `in_stock = true`. Under the documented
/// `(A AND B) OR C` grouping it must still appear (the OR includes it
/// unconditionally); under the wrong grouping
/// `A AND (B OR C)` it would be excluded (`category = electronics` fails,
/// and that failure isn't rescued by the OR since it's nested inside the
/// AND). So asserting its presence is what actually tests precedence, not
/// just acceptance.
#[tokio::test]
async fn v6_and_or_precedence() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(
        &srv,
        "V6",
        "products",
        "category = electronics AND created_on > 2016-01-01 OR in_stock = true",
    )
    .await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.iter().any(|r| r["sku"] == "TOYS-1001"),
        "V6: TOYS-1001 (in_stock=true, category != electronics) should match via the OR \
         branch under correct (A AND B) OR C precedence — its absence would mean the parser \
         grouped this as A AND (B OR C) instead"
    );
}

/// V7: `name LIKE %smith%` — `%` preserved in an unquoted bare value.
/// Doc's generic `name` swapped for real `users.full_name`; pattern
/// swapped to `%Dach%` (matches the seeded "Elmo Dach", confirmed live)
/// so the case-sensitive match is actually verifiable.
#[tokio::test]
async fn v7_like_bare_value() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V7", "users", "full_name LIKE %Dach%").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["full_name"], "Elmo Dach");
}

/// V8: quoted value containing a space. Same `full_name`/`Dach` pairing as
/// V7, but with a leading literal space in the pattern that requires
/// quoting to express at all.
#[tokio::test]
async fn v8_like_quoted_value_with_space() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V8", "users", "full_name LIKE '% Dach%'").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["full_name"], "Elmo Dach");
}

/// V9: `note = 'it''s fine'` — doubled-quote escape decodes to `it's fine`.
/// Doc's `note` column doesn't exist anywhere in the seed schema; swapped
/// for real `products.description` (nullable text). No seeded description
/// is literally "it's fine" (confirmed live), so this is a genuine
/// zero-match query — the point is the escaping parses and binds safely,
/// not that it matches anything.
#[tokio::test]
async fn v9_doubled_quote_escape() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V9", "products", "description = 'it''s fine'").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.is_empty(),
        "V9: no seeded product description should match \"it's fine\""
    );
}

/// V10: `deleted_at IS NULL` — valueless condition. Doc's `deleted_at`
/// doesn't exist anywhere in the seed schema; swapped for real
/// `users.last_login_at` (nullable). 6/50 seeded users have a NULL
/// `last_login_at` (confirmed live).
#[tokio::test]
async fn v10_is_null() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V10", "users", "last_login_at IS NULL").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        6,
        "V10: expected the 6 seeded users with NULL last_login_at"
    );
    for row in rows {
        assert!(row["last_login_at"].is_null());
    }
}

/// V11: `deleted_at IS NOT NULL` — same substitution as V10.
/// 44/50 seeded users have a non-NULL `last_login_at`.
#[tokio::test]
async fn v11_is_not_null() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V11", "users", "last_login_at IS NOT NULL").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        44,
        "V11: expected the 44 seeded users with non-NULL last_login_at"
    );
}

/// V12: `status = 'AND'` — quoted keyword used as a literal value.
/// Real `orders.status`; no seeded order has this value, so it's an
/// intentional zero-match query exercising the quoting, not the data.
#[tokio::test]
async fn v12_quoted_and_keyword_as_value() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V12", "orders", "status = 'AND'").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.is_empty(),
        "V12: no order status literally equals \"AND\""
    );
}

/// V13: lowercase `and`/`or` keywords. Doc uses 3 placeholder columns
/// (`a`/`b`/`c`); the point of this case is keyword case-insensitivity,
/// not distinctness of columns, so it reuses one real column
/// (`products.price`) three times.
#[tokio::test]
async fn v13_lowercase_keywords() {
    let srv = TestServer::spawn().await;
    assert_accepted(
        &srv,
        "V13",
        "products",
        "price = 1 and price = 2 or price = 3",
    )
    .await;
}

/// V14: `payload = '{"a": 1}'` — jsonb-ish quoted value. Real column: the
/// seed schema literally has an `events.payload` jsonb column, matching
/// the doc's illustrative name exactly.
#[tokio::test]
async fn v14_jsonb_quoted_value() {
    let srv = TestServer::spawn().await;
    assert_accepted(&srv, "V14", "events", r#"payload = '{"a": 1}'"#).await;
}

/// V15: `email = ''` — empty quoted value. Real `users.email` (`not null
/// unique`), so this is a guaranteed zero-match query (confirmed live: no
/// seeded email is empty), same reasoning as V9/V12.
#[tokio::test]
async fn v15_empty_quoted_value() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V15", "users", "email = ''").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(rows.is_empty(), "V15: no seeded user has an empty email");
}

/// V16: `name ILIKE '%SMITH%'` — case-insensitive LIKE. Doc's generic
/// `name` swapped for `users.full_name`; pattern swapped to lowercase
/// `%dach%` against the seeded "Elmo Dach" specifically to demonstrate
/// case-insensitivity (a same-case pattern wouldn't prove ILIKE differs
/// from LIKE at all).
#[tokio::test]
async fn v16_ilike_case_insensitive() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V16", "users", "full_name ILIKE '%dach%'").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["full_name"], "Elmo Dach");
}

/// V17: `NOT status = completed` — prefix negation on a plain comparison.
/// Real `orders.status`, same column as V1 but negated: should return the
/// 101 non-completed orders (201 total - 100 completed), clamped to a
/// full default-size page.
#[tokio::test]
async fn v17_not_prefix_on_comparison() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V17", "orders", "NOT status = completed").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        50,
        "V17: expected a full page of non-completed orders"
    );
    for row in rows {
        assert_ne!(row["status"], "completed");
    }
}

/// V18: `NOT email ILIKE '%test%'` — prefix negation on ILIKE. This one
/// needs no substitution at all: `users.email` matches the doc's
/// illustrative column exactly. No seeded email contains "test"
/// (confirmed live), so all 50 users match.
#[tokio::test]
async fn v18_not_prefix_on_ilike() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V18", "users", "NOT email ILIKE '%test%'").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        50,
        "V18: no seeded email contains \"test\", so every user should match"
    );
}

/// V19: `NOT deleted_at IS NULL` — prefix negation on a valueless
/// condition, legal alternate spelling of `IS NOT NULL`. Same
/// `last_login_at` substitution as V10/V11; should match the same 44 rows
/// as V11.
#[tokio::test]
async fn v19_not_prefix_on_is_null() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V19", "users", "NOT last_login_at IS NULL").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        44,
        "V19: NOT ... IS NULL should match the same rows as IS NOT NULL (V11)"
    );
}

/// V20: `not status = completed` — lowercase `NOT`, parallels V13's
/// lowercase `and`/`or`. Same column/semantics as V17.
#[tokio::test]
async fn v20_lowercase_not() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V20", "orders", "not status = completed").await;
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        50,
        "V20: expected a full page of non-completed orders"
    );
}

/// V21: `status = 'NOT'` — quoted keyword as value, parallels V12.
#[tokio::test]
async fn v21_quoted_not_keyword_as_value() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "V21", "orders", "status = 'NOT'").await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.is_empty(),
        "V21: no order status literally equals \"NOT\""
    );
}

// ============================ Rejected (R1-R16) =============================
//
// R1 (empty string) is handled separately below — it's "no filter", not a
// parse target, and the existing test for it needed no change.
//
// These are a regression net, not red tests: the current stub already
// 400s everything, so these already pass today for the wrong reason and
// should keep passing for the right reason once the parser lands. None of
// these need a real column — the rejection happens at parse time, before
// the query builder ever looks at the schema — so table is just "users"
// throughout and columns keep the doc's placeholder names verbatim.

/// R2: `status =` — missing value.
#[tokio::test]
async fn r2_missing_value() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R2", "users", "status =").await;
}

/// R3: `= completed` — missing column.
#[tokio::test]
async fn r3_missing_column() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R3", "users", "= completed").await;
}

/// R4: `status == completed` — unknown operator.
#[tokio::test]
async fn r4_unknown_operator() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R4", "users", "status == completed").await;
}

/// R5: `status = a AND` — trailing logic token.
#[tokio::test]
async fn r5_trailing_logic_token() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R5", "users", "status = a AND").await;
}

/// R6: `(status = a)` — parentheses unsupported.
#[tokio::test]
async fn r6_parentheses_unsupported() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R6", "users", "(status = a)").await;
}

/// R7: `status = a; DROP TABLE users` — `;` can't appear in a bare
/// value's grammar role; trailing garbage after a complete filter.
/// (The payload naming `users` and this test's own `table=users` is
/// coincidental — the doc's literal string just happens to name the same
/// table this suite defaults R-cases to; the rejection is purely
/// grammar-level and doesn't depend on that overlap.)
#[tokio::test]
async fn r7_trailing_garbage_after_filter() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R7", "users", "status = a; DROP TABLE users").await;
}

/// R8: `status = 'unterminated` — unclosed quote.
#[tokio::test]
async fn r8_unclosed_quote() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R8", "users", "status = 'unterminated").await;
}

/// R9: `1abc = x` — column can't start with a digit.
#[tokio::test]
async fn r9_column_starts_with_digit() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R9", "users", "1abc = x").await;
}

/// R10: `status LIKE` — word operator missing value.
#[tokio::test]
async fn r10_word_operator_missing_value() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R10", "users", "status LIKE").await;
}

/// R11: `a = 1 OR OR b = 2` — doubled logic token.
#[tokio::test]
async fn r11_doubled_logic_token() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R11", "users", "a = 1 OR OR b = 2").await;
}

/// R12: `status NOT = completed` — mid-predicate `NOT` unsupported; only
/// the prefix form (`NOT status = completed`, V17) is legal.
#[tokio::test]
async fn r12_mid_predicate_not_unsupported() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R12", "users", "status NOT = completed").await;
}

/// R13: 1 KiB+ filter string — length limit.
#[tokio::test]
async fn r13_length_limit_exceeded() {
    let srv = TestServer::spawn().await;
    let filter = "a = ".to_string() + &"x".repeat(1200);
    assert_rejected(&srv, "R13", "users", &filter).await;
}

/// R14: 11+ ANDed conditions — condition-count limit.
#[tokio::test]
async fn r14_condition_count_limit_exceeded() {
    let srv = TestServer::spawn().await;
    let filter = anded_conditions(11, "a = 1");
    assert_rejected(&srv, "R14", "users", &filter).await;
}

/// R15: `NOT NOT status = completed` — double negation; `[NOT]` is
/// zero-or-one, not recursive.
#[tokio::test]
async fn r15_double_negation_rejected() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R15", "users", "NOT NOT status = completed").await;
}

/// R16: `status = NOT` — bare `NOT` is always the keyword; quote it
/// (`status = 'NOT'`, V21) to use as a literal value.
#[tokio::test]
async fn r16_bare_not_is_keyword_not_literal() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "R16", "users", "status = NOT").await;
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

// =========================== Adversarial (A1-A10) ===========================

/// A1: `status = '''; DROP TABLE users; --'` — parses; the value becomes
/// a bind param, harmless. Real `orders.status`, same column as V1/V12.
#[tokio::test]
async fn a1_sql_injection_value_parses_as_bind_param() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "A1", "orders", "status = '''; DROP TABLE users; --'").await;
    // The point isn't the row content, it's that this didn't 500 / execute
    // arbitrary SQL. `rows` being an array only proves this specific
    // request came back coherent; it says nothing about whether the
    // injected DROP TABLE actually ran. Follow up with a real request
    // against `users` — if the drop had executed, this would 400/500
    // instead of succeeding, since the table (and its schema-allow-list
    // entry) would be gone.
    assert!(body["rows"].is_array());
    let users_still_exist = fetch(&srv, "users", "").await;
    assert_eq!(
        users_still_exist.status(),
        200,
        "A1: `users` should still exist and be queryable — the injected DROP TABLE must not have executed"
    );
}

/// A2: `id = 1 OR 1=1` — rejected: the second condition's column `1`
/// starts with a digit (R9). This is a parse-level rejection (a bare `1`
/// can never start a `column`), so it doesn't matter that the first
/// condition's `id` column is real or not.
#[tokio::test]
async fn a2_second_condition_digit_leading_column_rejected() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "A2", "orders", "id = 1 OR 1=1").await;
}

/// A3: `col"name = x` — `"` isn't legal in a column, rejected at the lexer.
#[tokio::test]
async fn a3_double_quote_illegal_in_column_rejected() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "A3", "users", "col\"name = x").await;
}

/// A4: `name LIKE '%'' OR ''1''=''1'` — parses; the entire pattern is one
/// bind param. Doc's generic `name` swapped for real `users.full_name`.
#[tokio::test]
async fn a4_like_pattern_injection_attempt_parses_as_bind_param() {
    let srv = TestServer::spawn().await;
    let body = assert_accepted(&srv, "A4", "users", "full_name LIKE '%'' OR ''1''=''1'").await;
    assert!(body["rows"].is_array());
}

/// A5: `status = 𝕔𝕠𝕞𝕡𝕝𝕖𝕥𝕖𝕕` (unicode confusables) — parses as a bare
/// value; bind param, harmless. Real `orders.status`, same column as A1.
#[tokio::test]
async fn a5_unicode_confusable_value_parses() {
    let srv = TestServer::spawn().await;
    let filter = "status = \u{1D554}\u{1D560}\u{1D62C}\u{1D629}\u{1D5F5}\u{1D5F2}\u{1D629}\u{1D5F2}\u{1D5F1}";
    let body = assert_accepted(&srv, "A5", "orders", filter).await;
    let rows = body["rows"].as_array().unwrap();
    assert!(
        rows.is_empty(),
        "A5: the unicode confusable value is not the real string \"completed\", so it shouldn't match"
    );
}

/// A6: `ｓｔａｔｕｓ = x` (fullwidth column) — not `[a-zA-Z0-9_]`, rejected.
#[tokio::test]
async fn a6_fullwidth_column_rejected() {
    let srv = TestServer::spawn().await;
    let filter = "\u{FF53}\u{FF54}\u{FF41}\u{FF54}\u{FF55}\u{FF53} = x";
    assert_rejected(&srv, "A6", "users", filter).await;
}

/// A7: `status = x` with an embedded NUL byte in the column — rejected
/// (NUL is not whitespace, not legal in a column).
///
/// This is intentional test data, not corruption: the NUL is a real `\0`
/// byte in the Rust string, not an escaped placeholder. Checked live
/// against this harness (`reqwest` 0.13, query-string params): the NUL
/// byte survives percent-encoding (`reqwest`'s `Serializer` encodes it as
/// `%00`) and reaches the server as a literal byte in the decoded query
/// param — `.send()` does not error client-side, and the server does not
/// reject the request at the HTTP/routing layer. So the rejection this
/// test checks for is squarely the filter parser's job (an in-band NUL
/// failing the column grammar), not something the transport layer does
/// for free — confirmed empirically before writing this assertion.
#[tokio::test]
async fn a7_embedded_nul_byte_rejected() {
    let srv = TestServer::spawn().await;
    let filter = "statu\0s = x";
    assert_rejected(&srv, "A7", "users", filter).await;
}

/// A8: column named `pg_sleep` — lexically legal, but fails the schema
/// allow-list check once it reaches the query builder. Distinct in kind
/// from a syntax-level rejection (R-cases): the filter parses fine, it's
/// the builder's `information_schema` check (`filter-dsl.md` §3 point 1)
/// that rejects it. Same HTTP-level assertion either way: 400.
#[tokio::test]
async fn a8_unknown_column_fails_allow_list() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "A8", "users", "pg_sleep = 1").await;
}

/// A9 (parses half): exactly 10 ANDed conditions is at the count limit,
/// not over it — should parse and execute. Doc uses placeholder `a = 1`;
/// swapped for real `orders.total_cents = 1` so this genuinely goes green
/// once the parser lands, instead of permanently failing the schema
/// allow-list check for an unrelated reason.
#[tokio::test]
async fn a9_boundary_ten_conditions_succeed() {
    let srv = TestServer::spawn().await;
    let filter = anded_conditions(10, "total_cents = 1");
    assert_accepted(&srv, "A9", "orders", &filter).await;
}

/// A9 (rejects half): exactly 11 ANDed conditions exceeds the count limit
/// — should be rejected regardless of column reality, no stack recursion
/// (parser must be iterative). Split out from the parses-half per the
/// task: the original file collapsed both onto one 11-condition case
/// "since both are 400 today", which loses the boundary this case exists
/// to test.
#[tokio::test]
async fn a9_boundary_eleven_conditions_rejected() {
    let srv = TestServer::spawn().await;
    let filter = anded_conditions(11, "total_cents = 1");
    assert_rejected(&srv, "A9", "orders", &filter).await;
}

/// A10: `NOT pg_sleep = 1` — parses (lexically legal) but fails the same
/// schema allow-list check as A8; `NOT` doesn't bypass allow-listing.
#[tokio::test]
async fn a10_not_prefix_does_not_bypass_allow_list() {
    let srv = TestServer::spawn().await;
    assert_rejected(&srv, "A10", "users", "NOT pg_sleep = 1").await;
}
