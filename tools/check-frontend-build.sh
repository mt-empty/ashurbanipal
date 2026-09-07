#!/bin/sh
set -eu

# Fails if frontend/dbviewer.html is not what frontend/src/ currently builds to.
# On mismatch the committed copy is restored, so a failed check leaves the tree
# clean (dbviewer.html is generated but committed — docs/frontend-style-guide.md).

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
(cd "$root/frontend" && node build.mjs)

if ! git -C "$root" diff --quiet HEAD -- frontend/dbviewer.html; then
    git -C "$root" checkout HEAD -- frontend/dbviewer.html
    printf '%s\n' "frontend/dbviewer.html is out of date; run: mise run frontend:build" >&2
    exit 1
fi
