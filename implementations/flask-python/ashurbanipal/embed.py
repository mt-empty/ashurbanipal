"""Loads the vendored `frontend/dbviewer.html` and re-verifies its sha256
on every process start — mirrors the Go port's `embed.go` and the Node
port's `embed.ts`. A build pipeline (bundler, resource filtering) can
silently mangle the vendored file, so the hash is checked on every load,
not just recorded once at vendoring time (`PORTING.md`'s vendoring
contract, hardening checklist item 3).

Pins this repo's own copy of `frontend/dbviewer.html`, same caveat the Go
and Node ports document: there is no separate tagged release to vendor
from yet.
"""

from __future__ import annotations

import gzip
import hashlib
from pathlib import Path

PINNED_FRONTEND_SHA256 = "e6c73182eb05688af6ced2a1c59d119b8ffb18642e0401b1fd34702f19858355"

_FRONTEND_PATH = Path(__file__).resolve().parent / "frontend" / "dbviewer.html"


def _load_frontend() -> str:
    contents = _FRONTEND_PATH.read_text(encoding="utf-8")
    actual = hashlib.sha256(contents.encode("utf-8")).hexdigest()
    if actual != PINNED_FRONTEND_SHA256:
        raise RuntimeError(
            f"ashurbanipal: frontend/dbviewer.html sha256 mismatch: expected "
            f"{PINNED_FRONTEND_SHA256}, got {actual} (the vendored frontend changed "
            "upstream — re-pin deliberately, don't silently accept a mangled copy)"
        )
    return contents


DBVIEWER_HTML = _load_frontend()

DBVIEWER_HTML_GZIP = gzip.compress(DBVIEWER_HTML.encode("utf-8"), compresslevel=9, mtime=0)
