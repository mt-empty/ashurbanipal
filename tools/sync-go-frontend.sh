#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source="$root/frontend/dbviewer.html"
go_frontend="$root/implementations/go-nethttp/frontend/dbviewer.html"
go_embed="$root/implementations/go-nethttp/embed.go"
spring_build="$root/implementations/spring-boot-starter/build.gradle.kts"
sha256=$(sha256sum "$source" | awk '{print $1}')

if [ "${1:-}" = "--check" ]; then
    cmp -s "$source" "$go_frontend" || {
        printf '%s\n' 'Go frontend is out of sync; run: mise run frontend:sync-go' >&2
        exit 1
    }
    grep -Fq "const pinnedFrontendSHA256 = \"$sha256\"" "$go_embed" || {
        printf '%s\n' 'Go frontend checksum is out of sync; run: mise run frontend:sync-go' >&2
        exit 1
    }
    grep -Fq "val pinnedFrontendSha256 = \"$sha256\"" "$spring_build" || {
        printf '%s\n' 'Spring frontend checksum is out of sync; run: mise run frontend:sync-go' >&2
        exit 1
    }
    exit 0
fi

if [ "$#" -ne 0 ]; then
    printf '%s\n' "usage: $0 [--check]" >&2
    exit 2
fi

cp "$source" "$go_frontend"
sed -i -E "s/(const pinnedFrontendSHA256 = \")[0-9a-f]{64}/\1$sha256/" "$go_embed"
sed -i -E "s/(val pinnedFrontendSha256 = \")[0-9a-f]{64}/\1$sha256/" "$spring_build"