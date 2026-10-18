"""HTTP-level DbError -> response-shape mapping (spec/protocol.md §2: every
error response, 500s included, must be application/problem+json). Regression
coverage for a real driver failure specifically: before `wrap_driver_errors`
(db/__init__.py), none of the three backends' DbSource methods ever raised
DatabaseError, so @bp.errorhandler(DbError) never fired for one and Flask's
default HTML error page leaked through instead.
"""

import json

from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.db import (
    BadJoin,
    DatabaseError,
    DbSource,
    FilterParseError,
    NotAllowed,
    NotAllowedKind,
    QueryTimeout,
)
from ashurbanipal.routes import router


class _FailingSource(DbSource):
    def __init__(self, exc: Exception):
        self._exc = exc

    def list_schemas(self):
        raise self._exc

    def list_tables(self, schema):
        raise self._exc

    def table_counts(self, schema):
        raise self._exc

    def query_table(self, schema, table, opts):
        raise self._exc

    def common_values(self, schema, table, column):
        raise self._exc

    def referenced_by(self, schema, table):
        raise self._exc

    def structure(self, schema, table):
        raise self._exc

    def query_join(self, schema, spec, opts):
        raise self._exc


def _client(exc: Exception):
    app = Flask(__name__)
    config = Config(enabled=True)
    app.register_blueprint(router(config, [("primary", _FailingSource(exc))]))
    return app.test_client()


def test_database_error_is_a_problem_json_500_not_flasks_default_html_page() -> None:
    client = _client(DatabaseError("connection reset"))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 500
    assert resp.content_type == "application/problem+json"
    body = json.loads(resp.data)
    assert body["code"] == "database_error"
    assert body["status"] == 500
    assert body["title"] == "database error: connection reset"


def test_not_allowed_is_a_400() -> None:
    client = _client(NotAllowed("table 'secrets'", kind=NotAllowedKind.NOT_READABLE))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 400
    assert resp.content_type == "application/problem+json"
    body = json.loads(resp.data)
    assert body["code"] == "not_readable"


def test_filter_parse_error_is_a_400() -> None:
    client = _client(FilterParseError("condition 0 is missing logic"))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 400
    assert resp.content_type == "application/problem+json"
    body = json.loads(resp.data)
    assert body["code"] == "invalid_filter"


_JOIN = (
    "/__ashurbanipal/api/tables/join?join="
    "%7B%22table%22%3A%22o%22%2C%22joins%22%3A%5B%7B%22type%22%3A%22left%22%2C%22table%22%3A%22u%22%2C"
    "%22on%22%3A%5B%7B%22left%22%3A%7B%22join%22%3A0%2C%22column%22%3A%22a%22%7D%2C%22right%22%3A%22b%22%7D%5D%7D%5D%7D"
)


def test_query_timeout_is_a_problem_json_500_named_query_timeout() -> None:
    resp = _client(QueryTimeout("canceling statement due to statement timeout")).get(_JOIN)
    assert resp.status_code == 500
    assert resp.content_type == "application/problem+json"
    assert json.loads(resp.data)["code"] == "query_timeout"


def test_bad_join_is_a_400_invalid_join() -> None:
    resp = _client(BadJoin("join 1 on: orders.status (text) cannot be joined to users.id (uuid)")).get(_JOIN)
    assert resp.status_code == 400
    assert resp.content_type == "application/problem+json"
    body = json.loads(resp.data)
    assert body["code"] == "invalid_join"
    assert "orders.status (text)" in body["title"]
