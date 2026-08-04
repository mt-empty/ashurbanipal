#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
generated=$(mktemp)
trap 'rm -f "$generated"' EXIT

(cd "$root/tools/seed-gen" && cargo run) >"$generated"

cmp -s "$generated" "$root/.devcontainer/db/init/01-seed.sql" || {
    printf '%s\n' ".devcontainer/db/init/01-seed.sql is out of date; run: mise run conformance:seed-gen" >&2
    exit 1
}

cmp -s "$generated" "$root/conformance/seed/seed.sql" || {
    printf '%s\n' "conformance/seed/seed.sql is out of date; run: mise run conformance:seed-gen" >&2
    exit 1
}
