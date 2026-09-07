#!/bin/sh
set -eu

# Fails if docs/demo/index.html is not what frontend/src/ + dbviewer.html
# currently build to. On mismatch the committed copy is restored.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
(cd "$root/frontend" && node build-demo.mjs)

if ! git -C "$root" diff --quiet HEAD -- docs/demo/index.html; then
    git -C "$root" checkout HEAD -- docs/demo/index.html
    printf '%s\n' "docs/demo/index.html is out of date; run: mise run frontend:build-demo" >&2
    exit 1
fi
