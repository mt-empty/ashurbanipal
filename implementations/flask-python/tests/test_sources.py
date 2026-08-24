"""HTTP-level multi-source support (`spec/protocol.md` §1, §5.8) — mirrors
`implementations/rust/axum/tests/`'s source-resolution coverage. Two
genuinely distinct SQLite-backed sources (different seeded rows, not two
names pointing at the same data) so "which source answered" is
observable from the response body, not just the source list.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path

import pytest
from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.db.sqlite import SqliteSource
from ashurbanipal.routes import router


def _seeded_path(email: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.executescript("create table users (id integer primary key, email text not null);")
    conn.execute("insert into users (email) values (?)", (email,))
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def two_sources():
    primary_path = _seeded_path("primary@x.com")
    reporting_path = _seeded_path("reporting@x.com")
    yield [
        ("primary", SqliteSource(primary_path)),
        ("reporting", SqliteSource(reporting_path)),
    ]
    Path(primary_path).unlink()
    Path(reporting_path).unlink()


def _client(sources):
    app = Flask(__name__)
    app.register_blueprint(router(Config(enabled=True), sources))
    return app.test_client()


def test_list_sources_returns_registered_names_in_order(two_sources) -> None:
    client = _client(two_sources)
    resp = client.get("/__ashurbanipal/api/sources")
    assert resp.status_code == 200
    assert resp.get_json() == {"sources": [{"name": "primary"}, {"name": "reporting"}]}


def test_unrecognized_source_is_rejected(two_sources) -> None:
    client = _client(two_sources)
    resp = client.get("/__ashurbanipal/api/schemas?source=no_such_source")
    assert resp.status_code == 400
    assert resp.content_type == "text/plain; charset=utf-8"


def test_omitted_source_resolves_to_first_registered(two_sources) -> None:
    client = _client(two_sources)
    resp = client.get("/__ashurbanipal/api/tables/data?table=users")
    assert resp.status_code == 200
    rows = resp.get_json()["rows"]
    assert [r["email"] for r in rows] == ["primary@x.com"]


def test_explicit_source_selects_the_named_one(two_sources) -> None:
    client = _client(two_sources)
    resp = client.get("/__ashurbanipal/api/tables/data?table=users&source=reporting")
    assert resp.status_code == 200
    rows = resp.get_json()["rows"]
    assert [r["email"] for r in rows] == ["reporting@x.com"]
