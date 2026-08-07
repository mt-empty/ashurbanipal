"""Unit test for `_LenientTextLoader` — doesn't need a live DATABASE_URL
(unlike test_postgres_integration.py) since it exercises the loader
directly, the way psycopg would invoke it mid row-decode.
"""

from __future__ import annotations

from ashurbanipal.db.postgres import _LenientTextLoader


def test_invalid_utf8_bytes_become_the_undecodable_sentinel() -> None:
    loader = _LenientTextLoader(oid=25)
    assert loader.load(b"\xff\xfe bad bytes") == "<undecodable>"
    assert loader.load(b"fine") == "fine"
