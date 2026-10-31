#!/bin/sh
set -eu

# Keeps the hardcoded version strings in the docs in sync with the single
# canonical ledger — the "What's published" table in
# docs/publishing-checklist.md. Only the Spring coordinate is irreducible:
# every other ecosystem has a "latest" mechanism the READMEs use instead
# (cargo add, go get @latest, pnpm/uv add), so it carries no version to drift.
#
#   check-doc-versions.sh          # verify, exit 1 on mismatch
#   check-doc-versions.sh --fix    # rewrite the READMEs to match the ledger

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ledger="$root/docs/publishing-checklist.md"
readmes="readme.md implementations/spring-boot-starter/README.md"

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

# Gradle-coordinate snippets (Maven has no "latest" in a dependency block, so
# this string is the one place a version must live).
for rel in $readmes; do
    readme="$root/$rel"
    found=$(grep -oE 'ashurbanipal-spring-boot-starter:[0-9]+\.[0-9]+\.[0-9]+' "$readme" \
        | sed 's/.*://' | sort -u)
    for v in $found; do
        [ "$v" = "$expected" ] && continue
        if [ "$fix" -eq 1 ]; then
            sed -i "s/ashurbanipal-spring-boot-starter:$v/ashurbanipal-spring-boot-starter:$expected/g" "$readme"
            printf '%s\n' "fixed: $rel Spring coordinate $v -> $expected"
        else
            printf '%s\n' "$rel pins Spring $v, ledger says $expected; run: mise run docs:check-versions --fix" >&2
            fail=1
        fi
    done
done

# The Spring README's Maven snippet carries the version on its own line.
spring_readme="$root/implementations/spring-boot-starter/README.md"
maven=$(grep -A1 '<artifactId>ashurbanipal-spring-boot-starter</artifactId>' "$spring_readme" \
    | grep -oE '<version>[0-9]+\.[0-9]+\.[0-9]+</version>' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
if [ -n "$maven" ] && [ "$maven" != "$expected" ]; then
    if [ "$fix" -eq 1 ]; then
        sed -i "s|<version>$maven</version>|<version>$expected</version>|" "$spring_readme"
        printf '%s\n' "fixed: Spring README Maven version $maven -> $expected"
    else
        printf '%s\n' "Spring README Maven snippet pins $maven, ledger says $expected; run: mise run docs:check-versions --fix" >&2
        fail=1
    fi
fi

# The ledger itself can't silently lie: its number must equal the highest
# pushed Spring release tag. The prefix moved from spring-v* to
# ashurbanipal-spring-boot-starter-v* (docs/publishing-checklist.md); match
# both while old tags are still around. Skipped (not failed) when no such tag
# is reachable — e.g. a CI checkout that didn't fetch tags.
if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    highest=$(git -C "$root" tag -l 'ashurbanipal-spring-boot-starter-v*' 'spring-v*' \
        | sed 's/^ashurbanipal-spring-boot-starter-v//; s/^spring-v//' | sort -V | tail -1)
    if [ -z "$highest" ]; then
        printf '%s\n' "note: no Spring release tags reachable; skipping ledger-vs-tag check" >&2
    elif [ "$highest" != "$expected" ]; then
        printf '%s\n' "ledger says Spring $expected, highest Spring tag is $highest; update $ledger" >&2
        fail=1
    fi
else
    printf '%s\n' "note: not a git checkout; skipping ledger-vs-tag check" >&2
fi

exit "$fail"
