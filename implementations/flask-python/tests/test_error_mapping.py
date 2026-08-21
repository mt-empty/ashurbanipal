"""HTTP-level DbError -> response-shape mapping (spec/protocol.md §2: every
error response, 500s included, must be text/plain). Regression coverage for
a real driver failure specifically: before `wrap_driver_errors` (db/__init__.py),
none of the three backends' DbSource methods ever raised DatabaseError, so
@bp.errorhandler(DbError) never fired for one and Flask's default HTML error
page leaked through instead.
"""

from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.db import DatabaseError, DbSource, FilterParseError, NotAllowed
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


def _client(exc: Exception):
    app = Flask(__name__)
    config = Config(enabled=True)
    app.register_blueprint(router(config, [("primary", _FailingSource(exc))]))
    return app.test_client()


def test_database_error_is_a_plain_text_500_not_flasks_default_html_page() -> None:
    client = _client(DatabaseError("connection reset"))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 500
    assert resp.content_type == "text/plain; charset=utf-8"
    assert resp.data == b"database error: connection reset"


def test_not_allowed_is_a_400() -> None:
    client = _client(NotAllowed("table 'secrets'"))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 400
    assert resp.content_type == "text/plain; charset=utf-8"


def test_filter_parse_error_is_a_400() -> None:
    client = _client(FilterParseError("condition 0 is missing logic"))
    resp = client.get("/__ashurbanipal/api/schemas")
    assert resp.status_code == 400
    assert resp.content_type == "text/plain; charset=utf-8"
