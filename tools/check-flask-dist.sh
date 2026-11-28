#!/bin/sh
set -eu

# Builds implementations/flask-python with `uv build` (wheel made from the
# sdist) into $1 or a temp dir, then imports the wheel in an isolated env;
# the import runs embed.py's sha256 check. Run tools/sync-ports-frontend.sh first.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dist=${1:-$work/dist}
mkdir -p "$dist"
dist=$(CDPATH= cd -- "$dist" && pwd)

cd "$root/implementations/flask-python"
uv build -q -o "$dist"

if ! tar -tzf "$dist"/*.tar.gz | grep '/ashurbanipal/frontend/dbviewer.html$' >/dev/null; then
    echo "sdist is missing ashurbanipal/frontend/dbviewer.html" >&2
    exit 1
fi

# -I keeps the source tree in the current directory off sys.path.
uv run -q --isolated --no-project --with "$dist"/*.whl python -I -c 'import ashurbanipal'
