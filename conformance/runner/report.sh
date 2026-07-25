#!/usr/bin/env bash
# Runs the conformance suite and writes conformance-report.json: suite
# version, target, and pass/fail per requirement ID from COVERAGE.md.
#
# Plain Rust test binaries can't emit `--format json` on stable without a
# custom harness (a real dependency, `libtest-mimic` or similar, just for
# this) — so this wraps the suite instead: run it normally (full human
# `cargo test` output, unchanged), parse the one line shape `cargo test`
# already guarantees on stable (`test <name> ... ok|FAILED`), and
# cross-reference that against COVERAGE.md's ID → test mapping.
#
# Usage: conformance/runner/report.sh [extra cargo-test args, e.g. a test
# filter]. Respects the same ASHURBANIPAL_CONFORMANCE_URL /
# ASHURBANIPAL_CONFORMANCE_SEED_DSN env vars as the suite itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COVERAGE="$ROOT/conformance/runner/COVERAGE.md"
OUT="${CONFORMANCE_REPORT_OUT:-$ROOT/conformance-report.json}"
SUITE_VERSION="$(tr -d '[:space:]' <"$ROOT/conformance/seed/VERSION")"
TARGET="${ASHURBANIPAL_CONFORMANCE_URL:-spawned (examples/demo against \$DATABASE_URL)}"

TEST_LOG="$(mktemp)"
RESULTS_TSV="$(mktemp)"
COVERAGE_TSV="$(mktemp)"
trap 'rm -f "$TEST_LOG" "$RESULTS_TSV" "$COVERAGE_TSV"' EXIT

# Human output is unchanged (tee), suite's own exit code decides ours.
set +e
(cd "$ROOT" && cargo test --test conformance -- "$@") 2>&1 | tee "$TEST_LOG"
SUITE_STATUS="${PIPESTATUS[0]}"
set -e

# "test module::fn ... ok" / "... FAILED" is the one stable-Rust output
# shape `cargo test` guarantees regardless of harness internals.
awk '/^test [a-zA-Z_0-9:]+ \.\.\. (ok|FAILED)$/ { print $2 "\t" $4 }' "$TEST_LOG" >"$RESULTS_TSV"

# COVERAGE.md data rows: "| `ID` | requirement prose | test refs / gap note |".
# Pull the ID, every `module::function`-shaped backtick span (the actual
# test references), and whether the row self-reports as a gap or as
# non-automatable (no test will ever cover it, by design).
grep -P '^\| `[A-Za-z0-9_.-]+` \|' "$COVERAGE" | while IFS= read -r row; do
    id="$(grep -oP '^\| `\K[A-Za-z0-9_.-]+(?=`)' <<<"$row" || true)"
    # `|| true`: a row with no `module::function` refs at all (a gap/
    # not-automated row) makes grep exit 1 with no match — expected, not a
    # script error, but fatal under `set -o pipefail` if left unguarded.
    tests="$( { grep -oP '`\K[a-z_][a-z_0-9]*::[a-z_][a-z_0-9]*(?=`)' <<<"$row" || true; } | paste -sd, -)"
    note="not-automated"
    if grep -q '\*\*gap\*\*' <<<"$row"; then
        note="gap"
    elif [[ -n "$tests" ]]; then
        note="automated"
    fi
    printf '%s\t%s\t%s\n' "$id" "$note" "$tests" >>"$COVERAGE_TSV"
done

RESULTS_JSON="$(jq -R -n '
  [inputs | select(length > 0) | split("\t") | {(.[0]): .[1]}] | add // {}
' "$RESULTS_TSV")"

REPORT="$(jq -n \
    --arg suite_version "$SUITE_VERSION" \
    --arg target "$TARGET" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson results "$RESULTS_JSON" \
    --slurpfile coverage_rows <(jq -R -n '
        # `select` inside the object literal below would (correctly, but
        # surprisingly) drop the *whole row* whenever tests=="" — select
        # produces zero outputs on a false test, and an object literal with
        # a zero-output field produces zero objects. if/then/else instead,
        # since a "gap"/non-automated row with no test refs at all is a
        # valid, expected row, not one to silently lose from the matrix.
        [inputs | select(length > 0) | split("\t") | {id: .[0], note: .[1], tests: (if (.[2] // "") == "" then [] else (.[2] | split(",")) end)}]
      ' "$COVERAGE_TSV") \
    '
    ($coverage_rows[0] // []) as $rows
    | ($rows | map(
        . as $row
        | ($row.tests // []) as $tests
        | {
            id: $row.id,
            tests: $tests,
            status: (
              if $row.note == "gap" then "gap"
              elif $row.note == "not-automated" then "not-automated"
              elif ($tests | length) == 0 then "not-automated"
              elif ($tests | map($results[.] // "MISSING") | any(. != "ok")) then "fail"
              else "pass"
              end
            )
          }
      )) as $requirements
    | {
        suite_version: $suite_version,
        target: $target,
        generated_at: $generated_at,
        requirements: $requirements,
        summary: {
          total: ($requirements | length),
          pass: ($requirements | map(select(.status == "pass")) | length),
          fail: ($requirements | map(select(.status == "fail")) | length),
          gap: ($requirements | map(select(.status == "gap")) | length),
          not_automated: ($requirements | map(select(.status == "not-automated")) | length),
        }
      }
    ')"

echo "$REPORT" >"$OUT"
echo "wrote $OUT"
jq '.summary' "$OUT"

exit "$SUITE_STATUS"
