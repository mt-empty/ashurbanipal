#!/bin/sh
set -eu

# Fails, listing the offending files, if any Go source under
# implementations/go-nethttp needs `gofmt` — the go toolchain has no
# check-only fmt mode of its own.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/implementations/go-nethttp"

unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
    printf '%s\n' "gofmt would reformat:" "$unformatted" >&2
    exit 1
fi
