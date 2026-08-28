#!/bin/sh
set -eu

# Verifies each port's implementations/<port>/CHANGELOG.md has a top versioned
# section that matches the port's manifest version — catches "bumped the
# version, forgot the changelog". Deterministic and offline: it does not run
# git-cliff or touch the network (git-cliff generation is a release-time step,
# see docs/publishing-checklist.md). A top section of "## [Unreleased]" is fine
# and skipped.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail=0

# port dir | manifest file | sed program to extract its version
set -- \
  "implementations/rust/core|Cargo.toml|s/^version = \"\(.*\)\"/\1/p" \
  "implementations/rust/axum|Cargo.toml|s/^version = \"\(.*\)\"/\1/p" \
  "implementations/rust/actix-web|Cargo.toml|s/^version = \"\(.*\)\"/\1/p" \
  "implementations/node-express|package.json|s/.*\"version\": \"\([^\"]*\)\".*/\1/p" \
  "implementations/flask-python|pyproject.toml|s/^version = \"\(.*\)\"/\1/p" \
  "implementations/spring-boot-starter|build.gradle.kts|s/^version = \"\(.*\)\"/\1/p" \
  "implementations/go-nethttp||"

for entry in "$@"; do
  dir=${entry%%|*}; rest=${entry#*|}
  manifest=${rest%%|*}; sedprog=${rest#*|}
  cl="$root/$dir/CHANGELOG.md"

  if [ ! -f "$cl" ]; then
    printf '%s\n' "missing: $dir/CHANGELOG.md" >&2
    fail=1
    continue
  fi

  top=$(grep -m1 -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]|^## \[Unreleased\]' "$cl" || true)
  if [ -z "$top" ]; then
    printf '%s\n' "$dir/CHANGELOG.md: no '## [x.y.z]' or '## [Unreleased]' heading found" >&2
    fail=1
    continue
  fi
  case "$top" in
    *Unreleased*) continue ;;
  esac

  # Go has no manifest — the tag is the version. File shape already checked.
  [ -n "$manifest" ] || continue

  cl_version=$(printf '%s' "$top" | sed -n 's/^## \[\([0-9.]*\)\]/\1/p')
  mf_version=$(sed -n "$sedprog" "$root/$dir/$manifest" | head -1)
  if [ "$cl_version" != "$mf_version" ]; then
    printf '%s\n' "$dir: CHANGELOG.md top section is $cl_version, $manifest is $mf_version" >&2
    fail=1
  fi
done

exit "$fail"
