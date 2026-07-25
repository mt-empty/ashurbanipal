#!/usr/bin/env bash
# Layer 2 (docs/design.md §4.2) — shape conformance: schemathesis fires
# requests generated from spec/openapi.yaml at a running implementation and
# asserts every response matches its documented type/nullability/status
# code. Complementary to conformance/runner (layer 3, behavior conformance
# over golden fixtures) — this proves shape, not logic, and never touches
# conformance/runner's own assertions.
#
# Two ways to run, mirroring conformance/runner/common.rs's Target split:
# - Spawned (default): builds and runs `examples/demo` against
#   $DATABASE_URL, on a free-ish local port.
# - External: ASHURBANIPAL_CONFORMANCE_URL names the target's mount root
#   directly (e.g. http://localhost:4000/__ashurbanipal) — no build/spawn,
#   the same path a port's own CI would exercise.
#
# `positive_data_acceptance` is excluded deliberately, not silently: it
# flags e.g. `table=""` as "schema-compliant input the API should have
# accepted", but table/column identifiers are validated against the live
# information_schema, a runtime property no static OpenAPI schema can
# express — an empty or nonexistent name legitimately 400s. Likewise the
# filter AST's "logic required on every element but the first" rule is
# positional, which JSON Schema's `items` (applied uniformly per element)
# can't encode either. Every other check stays on.
#
# Expect an occasional (seed-dependent, non-failing) "mostly rejected
# generated data" warning on GET /tables/common-values specifically: its
# `table`/`column` params are independently fuzzed strings, and nothing
# stops the fuzzer from pairing a real table with another table's column
# name — same runtime-vs-static-schema limitation as the exclusion above,
# just surfacing as a warning instead of a check result. Not a regression
# if it appears; don't chase it.
#
# Usage: conformance/runner/schema-check.sh [extra schemathesis args]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="$ROOT/.venv-schemathesis"
SCHEMA="$ROOT/spec/openapi.yaml"

if [ ! -x "$VENV/bin/schemathesis" ]; then
    echo "schemathesis not installed — run \`mise run schema-conformance-install\` first" >&2
    exit 1
fi

DEMO_PID=""
cleanup() {
    if [ -n "$DEMO_PID" ]; then
        kill "$DEMO_PID" 2>/dev/null || true
        wait "$DEMO_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if [ -n "${ASHURBANIPAL_CONFORMANCE_URL:-}" ]; then
    MOUNT_ROOT="${ASHURBANIPAL_CONFORMANCE_URL%/}"
else
    : "${DATABASE_URL:?DATABASE_URL must be set (the devcontainer sets it automatically)}"
    PORT="${ASHURBANIPAL_SCHEMA_CHECK_PORT:-4020}"
    PORT="$PORT" DATABASE_URL="$DATABASE_URL" \
        cargo run --manifest-path "$ROOT/implementations/rust/Cargo.toml" --example demo &
    DEMO_PID=$!

    ready=""
    for _ in $(seq 1 60); do
        if curl -sf "http://localhost:$PORT/health" >/dev/null; then
            ready=1
            break
        fi
        sleep 1
    done
    [ -n "$ready" ] || {
        echo "demo server did not become healthy on port $PORT within 60s" >&2
        exit 1
    }
    MOUNT_ROOT="http://localhost:$PORT/__ashurbanipal"
fi

"$VENV/bin/schemathesis" run "$SCHEMA" \
    -u "$MOUNT_ROOT/api" \
    --checks all \
    --exclude-checks positive_data_acceptance \
    --max-examples "${ASHURBANIPAL_SCHEMA_CHECK_EXAMPLES:-100}" \
    "$@"
