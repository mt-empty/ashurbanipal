# Conformance coverage matrix

Every normative requirement (`MUST`/`MUST NOT`) in `spec/protocol.md`,
mapped to the test function that verifies it. Built by reading the spec
section by section, not by reverse-engineering the existing suite — gaps
found this way became new tests (`conformance/runner/*.rs`) or, where a
gap genuinely can't be exercised over HTTP, an explicit entry in
[Known gaps](#known-gaps) or [Explicitly out of scope](#explicitly-out-of-scope-for-this-runner)
below.

`ID` is the requirement ID `report.sh`/`conformance-report.json` key
pass/fail against; `Test` is `module::function`, matching `cargo test`
output exactly.

## §2 Transport

| ID | Requirement | Test |
|---|---|---|
| `P2-GET-ONLY` | Every route is `GET`; no writes accepted | `protocol::writes_are_not_accepted` |
| `P2-CONTENT-TYPE` | Success = `application/json` (HTML route excepted) | implicit in every `.json()` call across the suite; explicit content-type check on the UI route: `html_and_siblings::root_serves_the_embedded_dbviewer_html` |
| `P2-ERROR-BODY-UNSPECIFIED` | Error bodies are `text/plain`, wording implementation-defined, MUST NOT be parsed | enforced by convention, not a single test: every error assertion in this suite goes through `assert_status()` (the status-only tier, see `assert.rs`), never a body-text match |
| `P2-HEADER-EVERY-RESPONSE` | Every API response, success or error, carries the protocol header | `protocol::every_api_response_carries_the_protocol_version_header`, `protocol::protocol_header_is_present_even_on_api_error_responses` |

## §3 Mount contract

| ID | Requirement | Test |
|---|---|---|
| `P3-MOUNT-PATHS` | UI at `{mount}`, API at `{mount}/api/...` | every test in the suite, via `TestServer::url()` |
| `P3-NO-EXTRA-ENDPOINTS` | No additional endpoints under `{mount}` | `html_and_siblings::unknown_path_under_mount_is_404` |
| `P3-NO-AUTH` | No authentication inside the mount | implicit: every request in this suite carries no credentials of any kind and every non-error case succeeds |

## §4 Kill switch

Out of scope for this runner — see [Explicitly out of scope](#explicitly-out-of-scope-for-this-runner).

## §5.1 UI route

| ID | Requirement | Test |
|---|---|---|
| `P5.1-SERVE-HTML` | Serves `dbviewer.html` as `text/html` | `html_and_siblings::root_serves_the_embedded_dbviewer_html` |
| `P5.1-UNMODIFIED-ARTIFACT` | Frontend artifact unmodified (mount-agnostic API base) | `html_and_siblings::dbviewer_html_does_not_hardcode_the_api_base` |

## §5.2 `GET /api/tables`

| ID | Requirement | Test |
|---|---|---|
| `P5.2-COMMENT-OMITTED` | `comment` omitted when the table has none | `tables::table_comments_are_present_only_where_seeded` |
| `P5.2-STABLE-ORDER` | Stable (name) order | `tables::lists_exactly_the_seeded_tables_in_alphabetical_order` |

## §5.3 `GET /api/table-counts`

| ID | Requirement | Test |
|---|---|---|
| `P5.3-FROM-CATALOG` | `approx_rows` from `pg_class.reltuples`, never `COUNT(*)` | `tables::table_counts_cover_all_seeded_tables_with_approx_rows` (range tier: can't distinguish reltuples from `COUNT(*)` output directly over HTTP, but the never-analyzed-table `-1` case below can only come from reltuples) |
| `P5.3-NEG-ONE-TOLERATED` | MAY be `-1` before first ANALYZE/VACUUM, clients tolerate both | `tables::table_counts_cover_all_seeded_tables_with_approx_rows` (`feature_flags` case) |

## §5.4 `GET /api/tables/data`

| ID | Requirement | Test |
|---|---|---|
| `P5.4-TABLE-EXACT-MATCH` | `table` MUST match §5.2 exactly, case-sensitive; else 400 | `table_data::malicious_table_values_are_rejected_cleanly_and_do_no_damage`, `table_data::table_param_match_is_case_sensitive` |
| `P5.4-SORT-VALIDATED` | `sort` validated against real columns; unknown → 400 | `table_data::malicious_sort_value_against_a_valid_table_is_rejected_cleanly` |
| `P5.4-ORDER-INVALID` | `order` invalid value → 400 | `table_data::invalid_order_value_is_rejected` |
| `P5.4-LIMIT-CLAMPED` | `limit` clamped to `[1, max_page_size]`, never rejected | `table_data::limit_defaults_to_fifty_and_clamps_to_configured_range`, `table_data::limit_boundary_values_are_not_off_by_one` |
| `P5.4-SORT-NATIVE-TYPE` | Sort uses native type ordering, not text rendering | `table_data::sort_and_order_are_respected` (basic asc/desc), `table_data::sort_on_a_numeric_column_is_numeric_not_lexicographic` (the native-type edge case) |

### §5.4.1 Column metadata

| ID | Requirement | Test |
|---|---|---|
| `P5.4.1-FK-METADATA` | `key`/`references` for FK columns | `table_data::foreign_key_columns_report_key_and_references` |
| `P5.4.1-COMMENT-OMITTED` | `comment` omitted when absent | `table_data::column_comments_are_present_only_where_seeded` |
| `P5.4.1-COMPOSITE-FK-OMITTED` | Composite FKs omit `key`/`references` entirely | `table_data::composite_foreign_key_columns_omit_key_metadata` |

### §5.4.2 Filter JSON AST

| ID | Requirement | Test |
|---|---|---|
| `P5.4.2-OP-SET` | `op` is exactly the fixed set/spellings | `filter_dsl::builder_fixture_cases_over_http` (fixture kind `bad_op`) |
| `P5.4.2-LOGIC-RULES` | `logic` absent on first, present on rest | `filter_dsl::builder_fixture_cases_over_http` (`missing_logic`, `unexpected_logic`); positive case: `filter_dsl::and_binds_tighter_than_or` |
| `P5.4.2-NOT-DEFAULT` | `not` optional, defaults false | `filter_dsl::not_negates_a_condition` |
| `P5.4.2-VALUE-PRESENCE` | `value` present/absent per op | `filter_dsl::builder_fixture_cases_over_http` (`missing_value`, `unexpected_value`); positive case: `filter_dsl::is_null_and_is_not_null_partition_rows` |
| `P5.4.2-MAX-CONDITIONS` | At most 10 conditions | `filter_dsl::builder_fixture_cases_over_http` (`too_many_conditions`) |
| `P5.4.2-OVERSIZE-BOUND` | Oversize filter (>8192 bytes decoded) → 400, never truncated | `filter_dsl::builder_fixture_cases_over_http` (`oversize`) |
| `P5.4.2-EMPTY-ARRAY` | Empty array ≡ absent filter | `filter_dsl::empty_param_and_empty_array_mean_no_filter` |
| `P5.4.2-DSL-TEXT-REJECTED` | DSL text in `filter` is rejected (no server-side grammar) | `filter_dsl::dsl_text_in_filter_param_is_rejected` |
| `P5.4.2-COLUMN-VALIDATED` | Column validated against real columns; unknown → 400 | `filter_dsl::unknown_column_rejection_is_a_400`, `filter_dsl::builder_fixture_cases_over_http` (`unknown_column`) |
| `P5.4.2-OP-HARDCODED-MAP` | `op` mapped through hardcoded table, never client text | `filter_dsl::equality_filter_narrows_rows` (`=` maps correctly), `filter_dsl::injection_value_stays_a_bind_param` (proxy: an operator escape attempt can only be inert if the mapping is hardcoded) |
| `P5.4.2-VALUE-BOUND-PARAM` | `value` bound as parameter, never concatenated | `filter_dsl::injection_value_stays_a_bind_param` |
| `P5.4.2-NOT-WRAPS` | `not: true` wraps in `NOT (...)`, no separate operator table | `filter_dsl::not_negates_a_condition` |
| `P5.4.2-AND-OR-PRECEDENCE` | `AND` binds tighter than `OR` | `filter_dsl::and_binds_tighter_than_or` |
| `P5.4.2-CONTRADICTORY-LEGAL` | Contradictory conditions are legal, return zero rows | `filter_dsl::contradictory_conditions_return_zero_rows_not_error` |

### §5.4.3 Value serialization

| ID | Requirement | Test |
|---|---|---|
| `P5.4.3-STRING-OR-NULL` | Every cell is a JSON string or `null`, never number/bool/nested | `table_data::every_cell_value_is_a_json_string_or_null` |
| `P5.4.3-UNDECODABLE-SENTINEL` | Undecodable value → `"<undecodable>"` sentinel | **gap** — see [Known gaps](#known-gaps) |

### §5.4.4 `total_approx`

| ID | Requirement | Test |
|---|---|---|
| `P5.4.4-FROM-RELTUPLES` | From `pg_class.reltuples` | `table_data::returns_requested_shape_and_row_count` (range tier) |
| `P5.4.4-UNAFFECTED-BY-FILTER` | MUST NOT be affected by `filter` | `filter_dsl::total_approx_is_unaffected_by_filter` |
| `P5.4.4-STALE-OR-NEG-ONE` | MAY be stale or `-1` | `table_data::returns_requested_shape_and_row_count`, `table_data::offset_is_unclamped_and_beyond_table_size_returns_empty_rows` (range tier throughout — never an exact value, per `docs/design.md` §4.2) |

## §5.5 `GET /api/tables/common-values`

| ID | Requirement | Test |
|---|---|---|
| `P5.5-VALIDATED` | `table`/`column` validated against live schema | `common_values::invalid_table_or_column_is_rejected_cleanly`, `common_values::column_belonging_to_a_different_table_is_rejected` |
| `P5.5-FROM-CATALOG-STATS` | From catalog stats only, never `SELECT DISTINCT` | `common_values::returns_value_freq_pairs_with_booleans_as_text_not_pg_array_literals` (proxy: boolean rendering only makes sense if the value came from `pg_stats`'s array literal form, not a live data scan) |
| `P5.5-EMPTY-WHEN-NO-STATS` | No stats → empty list, not an error | `common_values::no_stats_column_yields_empty_values_not_error` |
| `P5.5-FREQ-RANGE-AND-ORDER` | `freq` in `(0, 1]`, most frequent first | `common_values::returns_value_freq_pairs_with_booleans_as_text_not_pg_array_literals` (range tier + explicit ordering check) |
| `P5.5-VALUE-ROUNDTRIPS` | `value` rendering round-trips into an equality filter (boolean t/f → true/false) | `common_values::returns_value_freq_pairs_with_booleans_as_text_not_pg_array_literals` |

## §5.6 `GET /api/siblings`

| ID | Requirement | Test |
|---|---|---|
| `P5.6-EMPTY-CONFIG` | Empty config → `{"siblings": []}` | `html_and_siblings::siblings_endpoint_returns_empty_list_by_default` |
| `P5.6-ORIGIN-RESOLUTION` | Health resolved against origin, not `dbviewer_url` path | covered at the unit level only, not by this HTTP suite — `src/routes.rs`'s `health_url_resolves_against_origin` (pure function, no live sibling needed) |
| `P5.6-2XX-ONLY` | `healthy` true iff 2xx; any failure → false, never an error response | **gap** — see [Known gaps](#known-gaps) |
| `P5.6-PARALLEL-TIMEOUT-BOUND` | Checks SHOULD run in parallel, MUST be individually timeout-bounded | **gap** — see [Known gaps](#known-gaps) |

## §6 Server invariants

| ID | Requirement | Test |
|---|---|---|
| `P6-NO-UNVALIDATED-IDENTIFIER` | No unvalidated identifier ever reaches SQL text | `table_data::malicious_table_values_are_rejected_cleanly_and_do_no_damage`, `table_data::malicious_sort_value_against_a_valid_table_is_rejected_cleanly`, `filter_dsl::injection_value_stays_a_bind_param`, `filter_dsl::unknown_column_rejection_is_a_400` |
| `P6-READ-ONLY` | Read-only: only `SELECT`s execute | `protocol::writes_are_not_accepted` |
| `P6-QUERY-TIMEOUT-BOUNDED` | Every query bounded by a timeout | **gap** — see [Known gaps](#known-gaps) |
| `P6-SINGLE-TABLE-NO-JOINS` | Single table per query, no joins | not independently observable over HTTP beyond "every route's response only ever contains one table's columns/rows" — implicit in every `table_data`/`common_values` test, none of which ever request or receive cross-table shape |
| `P6-SCHEMA-SCOPING` | Schema scoping — `current_schema()`, never hardcoded | `tables::schema_scoping_excludes_other_schemas` |
| `P6-STATELESS` | Statelessness — no required server-side session | `protocol::every_api_response_carries_the_protocol_version_header` (asserts no `Set-Cookie`) |

## §7 Protocol version

| ID | Requirement | Test |
|---|---|---|
| `P7-HEADER-VALUE` | `x-ashurbanipal-protocol: 1` on every API response | `protocol::every_api_response_carries_the_protocol_version_header`, `protocol::protocol_header_is_present_even_on_api_error_responses` |
| `P7-VERSIONING-POLICY` | Versioning policy (what bumps the version) | not machine-testable — a policy about future changes, not an observable property of one running instance |

## Explicitly out of scope for this runner

Per `implementation.md` §2.2: these are process-startup behaviors, not
observable over HTTP from outside a running, enabled instance. They stay
implementation-level tests, already covered by `src/config.rs`'s own unit
tests (`cargo test` in the main crate, not this suite):

- **§4 Kill switch: production-like names rejected at config load.**
  `config::tests::production_aliases_rejected_at_parse_time`.
- **§4 Kill switch: disabled → all six routes 404.** No dedicated unit
  test name (the property falls out of `router()` returning
  `Router::new()` when `Config::is_enabled()` is false — see
  `src/routes.rs`'s `router()` doc comment); nothing to observe from
  outside a process that made the opposite choice.

A port's own test suite is expected to carry an equivalent — see
`PORTING.md` (Phase 6.1, not built in this task).

## Known gaps

Found while building this matrix; not closed here because closing them
needs infrastructure genuinely beyond a seed file + HTTP assertions
(unlike the gaps above, these aren't process-startup — they're just hard
to trigger deterministically):

- **§5.4.3 undecodable-value sentinel (`P5.4.3-UNDECODABLE-SENTINEL`).**
  Every seeded column decodes cleanly via `column::text`; provoking
  `DbError`'s undecodable path would need data that is valid at the
  Postgres level but fails Rust's UTF-8 text decode, which isn't
  something a portable `seed.sql` can reliably encode across
  implementations.
- **§5.6 sibling health semantics beyond the empty-config case
  (`P5.6-2XX-ONLY`, `P5.6-PARALLEL-TIMEOUT-BOUND`).** `healthy` reflecting
  a real 2xx/non-2xx/timeout/unreachable outcome, and the parallel +
  individually-bounded timeout requirement, both need a second live
  instance (or a deliberately slow/black-hole one) as a fixture —
  `tools/e2e-tests`' `siblings.spec.ts` already exercises the
  paired-instance case at the UI level (`mise run demo-sibling`'s
  pattern); this runner only proves the protocol-shape default (empty
  config ⇒ empty list).
- **§6 query timeout bound (`P6-QUERY-TIMEOUT-BOUNDED`).** There's no
  channel through the documented API surface to make a query
  pathologically slow — filter values are always bound parameters, never
  SQL text, so there's no way to ask the server to (say) call
  `pg_sleep()` from outside. Provoking a real 5s+ query would need a
  fixture engineered to make ordinary predicates slow (e.g. a
  pathological `ILIKE` over a huge unindexed column), which isn't a
  reliable, portable conformance fixture. Left as reviewer-checklist
  territory (`docs/design.md` §4.2's closing paragraph already flags
  this class of property as outside all three automatable layers).

None of these gate a "conformant" listing on their own (per
`docs/design.md` §4.2, that requires all three layers plus the
Phase 5.5 manual checklist) — they're recorded here so the checklist
doesn't silently assume HTTP conformance covers them.
