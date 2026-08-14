#!/bin/sh
set -eu

# Rust and Go commit their vendored copy (both ecosystems' packaging only
# includes files present in a real git commit at package time — see
# docs/publishing-checklist.md). Spring/Node/Flask generate theirs
# ephemerally at build/CI time instead (gitignored, force-included via
# their own build config despite that) since their tooling doesn't have
# that constraint - so only Rust/Go's copies are meaningful to diff here;
# Spring/Node/Flask just get regenerated.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source="$root/frontend/dbviewer.html"
rust_frontend="$root/implementations/rust/axum/frontend/dbviewer.html"
actix_frontend="$root/implementations/rust/actix-web/frontend/dbviewer.html"
go_frontend="$root/implementations/go-nethttp/frontend/dbviewer.html"
go_embed="$root/implementations/go-nethttp/embed.go"
spring_build="$root/implementations/spring-boot-starter/build.gradle.kts"
node_frontend="$root/implementations/node-express/frontend/dbviewer.html"
node_embed="$root/implementations/node-express/src/embed.ts"
flask_frontend="$root/implementations/flask-python/ashurbanipal/frontend/dbviewer.html"
flask_embed="$root/implementations/flask-python/ashurbanipal/embed.py"
sha256=$(sha256sum "$source" | awk '{print $1}')

if [ "${1:-}" = "--check" ]; then
    cmp -s "$source" "$rust_frontend" || {
        printf '%s\n' 'Rust frontend is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    cmp -s "$source" "$actix_frontend" || {
        printf '%s\n' 'Actix-web frontend is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    cmp -s "$source" "$go_frontend" || {
        printf '%s\n' 'Go frontend is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    grep -Fq "const pinnedFrontendSHA256 = \"$sha256\"" "$go_embed" || {
        printf '%s\n' 'Go frontend checksum is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    grep -Fq "val pinnedFrontendSha256 = \"$sha256\"" "$spring_build" || {
        printf '%s\n' 'Spring frontend checksum is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    grep -Fq "const PINNED_FRONTEND_SHA256 = \"$sha256\"" "$node_embed" || {
        printf '%s\n' 'Node frontend checksum is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    grep -Fq "PINNED_FRONTEND_SHA256 = \"$sha256\"" "$flask_embed" || {
        printf '%s\n' 'Flask frontend checksum is out of sync; run: mise run frontend:sync-ports' >&2
        exit 1
    }
    exit 0
fi

if [ "$#" -ne 0 ]; then
    printf '%s\n' "usage: $0 [--check]" >&2
    exit 2
fi

cp "$source" "$rust_frontend"
cp "$source" "$actix_frontend"
cp "$source" "$go_frontend"
sed -i -E "s/(const pinnedFrontendSHA256 = \")[0-9a-f]{64}/\1$sha256/" "$go_embed"
sed -i -E "s/(val pinnedFrontendSha256 = \")[0-9a-f]{64}/\1$sha256/" "$spring_build"
mkdir -p "$(dirname "$node_frontend")"
cp "$source" "$node_frontend"
sed -i -E "s/(const PINNED_FRONTEND_SHA256 = \")[0-9a-f]{64}/\1$sha256/" "$node_embed"
mkdir -p "$(dirname "$flask_frontend")"
cp "$source" "$flask_frontend"
sed -i -E "s/(PINNED_FRONTEND_SHA256 = \")[0-9a-f]{64}/\1$sha256/" "$flask_embed"
