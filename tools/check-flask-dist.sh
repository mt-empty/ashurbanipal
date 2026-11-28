#!/bin/sh
set -eu

# Builds implementations/flask-python the way the publish job does (`uv
# build`: sdist first, then the wheel from that sdist), or checks an
# existing dist directory given as $1, then imports the wheel in a clean
# venv. Importing runs embed.py's load + sha256 check of the frontend copy.
# Run tools/sync-ports-frontend.sh first.

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ $# -gt 0 ]; then
    dist=$(CDPATH= cd -- "$1" && pwd)
else
    dist="$work/dist"
    (cd "$root/implementations/flask-python" && uv build -q -o "$dist")
fi

set -- "$dist"/*.tar.gz
[ $# -eq 1 ] && [ -f "$1" ] || { echo "expected one sdist in $dist" >&2; exit 1; }
if ! tar -tzf "$1" | grep '/ashurbanipal/frontend/dbviewer.html$' >/dev/null; then
    echo "sdist $(basename "$1") is missing ashurbanipal/frontend/dbviewer.html" >&2
    exit 1
fi

set -- "$dist"/*.whl
[ $# -eq 1 ] && [ -f "$1" ] || { echo "expected one wheel in $dist" >&2; exit 1; }
wheel=$1

# Run from $work with -I so the import resolves to the installed wheel,
# never the source tree.
cd "$work"
uv venv -q --python 3.12 venv
uv pip install -q --python venv/bin/python "$wheel"
venv/bin/python -I -c "import ashurbanipal, ashurbanipal.embed; print('ok:', ashurbanipal.__file__)"
