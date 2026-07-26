//! The four comparison-rule tiers (`docs/design.md` §4.2 layer 3,
//! `spec/protocol.md` §2/§5.4.4/§5.5): byte-for-byte comparison is
//! incompatible with the spec itself (JSON key order isn't guaranteed,
//! error body text is implementation-defined), so every assertion in this
//! suite goes through one of these instead of an ad hoc `assert_eq!` a
//! reviewer would have to re-classify by eye.
//!
//! - [`assert_exact`] — row data, column metadata, pagination, filter
//!   results: everything the spec makes deterministic against the fixed
//!   seed.
//! - [`assert_row_estimate`] / [`assert_freq`] — type/range only:
//!   `total_approx`/`approx_rows` (non-negative or exactly `-1`, never a
//!   specific number) and `common-values` `freq` (a float in `[0,1]`, never
//!   an exact value).
//! - [`assert_status`] — error responses: status code only, never body
//!   text.
//! - Not checked at all: HTTP framing beyond the headers the spec actually
//!   requires. No helper — just don't assert on it.

use std::fmt::Debug;

/// Tier: exact match.
#[track_caller]
pub fn assert_exact<T: PartialEq + Debug>(actual: T, expected: T, what: &str) {
    assert_eq!(actual, expected, "{what} (tier: exact match)");
}

/// Tier: type/range only, specialized for `total_approx`
/// (`spec/protocol.md` §5.4.4) and `table-counts`' `approx_rows` (§5.3),
/// which share the same rule: a whole-table catalog estimate that MAY be
/// stale and MAY be `-1` before the table's first ANALYZE/VACUUM. Never
/// assert a specific value.
#[track_caller]
pub fn assert_row_estimate(value: &serde_json::Value, what: &str) {
    let n = value
        .as_i64()
        .unwrap_or_else(|| panic!("{what}: not an integer: {value} (tier: range only)"));
    assert!(
        n == -1 || n >= 0,
        "{what}: {n} must be -1 or >= 0 (spec/protocol.md §5.4.4) (tier: range only)"
    );
}

/// Tier: type/range only, for `common-values`' `freq` (`spec/protocol.md`
/// §5.5) — `pg_stats` sampling isn't reproducible run to run, so only the
/// `(0, 1]` bound is checked, never an exact frequency.
#[track_caller]
pub fn assert_freq(value: &serde_json::Value, what: &str) {
    let f = value
        .as_f64()
        .unwrap_or_else(|| panic!("{what}: not a number: {value} (tier: range only)"));
    assert!(
        f > 0.0 && f <= 1.0,
        "{what}: freq {f} not in (0, 1] (spec/protocol.md §5.5) (tier: range only)"
    );
}

/// Tier: status code only. `spec/protocol.md` §2: error body wording is
/// implementation-defined and clients MUST NOT parse it — so this suite
/// never does either.
#[track_caller]
pub fn assert_status(resp: &reqwest::Response, expected: u16, what: &str) {
    assert_eq!(
        resp.status().as_u16(),
        expected,
        "{what}: expected status {expected} (tier: status code only)"
    );
}
