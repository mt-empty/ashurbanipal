#!/bin/sh
set -eu

# Keeps the hardcoded version strings in the docs in sync with the single
# canonical ledger — the "What's published" table in
# docs/publishing-checklist.md. Only the Spring coordinate is irreducible:
# every other ecosystem has a "latest" mechanism the READMEs use instead
# (cargo add, go get @latest, pnpm/uv add), so it carries no version to drift.
#
#   check-doc-versions.sh          # verify, exit 1 on mismatch
#   check-doc-versions.sh --fix    # rewrite readme.md to match the ledger

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ledger="$root/docs/publishing-checklist.md"
readme="$root/readme.md"

fix=0
if [ "${1:-}" = "--fix" ]; then
    fix=1
elif [ "$#" -ne 0 ]; then
    printf '%s\n' "usage: $0 [--fix]" >&2
    exit 2
fi

# Source of truth: the Latest column of the Spring row in the ledger table.
expected=$(grep 'ashurbanipal-spring-boot-starter`' "$ledger" \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ -n "$expected" ] || {
    printf '%s\n' "could not read the Spring version from $ledger" >&2
    exit 1
}

fail=0

# readme.md's Gradle-coordinate snippets (Maven has no "latest" in a
# dependency block, so this string is the one place a version must live).
found=$(grep -oE 'ashurbanipal-spring-boot-starter:[0-9]+\.[0-9]+\.[0-9]+' "$readme" \
    | sed 's/.*://' | sort -u)
for v in $found; do
    [ "$v" = "$expected" ] && continue
    if [ "$fix" -eq 1 ]; then
        sed -i "s/ashurbanipal-spring-boot-starter:$v/ashurbanipal-spring-boot-starter:$expected/g" "$readme"
        printf '%s\n' "fixed: readme.md Spring coordinate $v -> $expected"
    else
        printf '%s\n' "readme.md pins Spring $v, ledger says $expected; run: mise run docs:check-versions --fix" >&2
        fail=1
    fi
done

# The ledger itself can't silently lie: its number must equal the highest
# pushed spring-v* release tag. Skipped (not failed) when no such tag is
# reachable — e.g. a CI checkout that didn't fetch tags.
if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    highest=$(git -C "$root" tag -l 'spring-v*' | sed 's/^spring-v//' | sort -V | tail -1)
    if [ -z "$highest" ]; then
        printf '%s\n' "note: no spring-v* tags reachable; skipping ledger-vs-tag check" >&2
    elif [ "$highest" != "$expected" ]; then
        printf '%s\n' "ledger says Spring $expected, highest spring-v* tag is $highest; update $ledger" >&2
        fail=1
    fi
else
    printf '%s\n' "note: not a git checkout; skipping ledger-vs-tag check" >&2
fi

exit "$fail"
