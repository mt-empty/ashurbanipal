"""HTTP-level kill-switch behavior — mirrors
`implementations/go-nethttp/killswitch_test.go` and
`implementations/node-express/test/killswitch.test.ts`. Every mount path
must 404 identically to an unmounted app, and the enabled case must carry
the protocol header on API routes but not the HTML route.
"""

from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.db import DbSource
from ashurbanipal.routes import router

ALL_MOUNT_PATHS = [
    "/__ashurbanipal",
    "/__ashurbanipal/api/schemas",
    "/__ashurbanipal/api/tables",
    "/__ashurbanipal/api/table-counts",
    "/__ashurbanipal/api/tables/data",
    "/__ashurbanipal/api/tables/common-values",
    "/__ashurbanipal/api/siblings",
]


class _UnusedSource(DbSource):
    """Stands in for a DbSource in tests that never issue a request
    reaching the database — router() never touches the source at
    construction time, only per-request.
    """

    def list_schemas(self):
        raise NotImplementedError

    def list_tables(self, schema):
        raise NotImplementedError

    def table_counts(self, schema):
        raise NotImplementedError

    def query_table(self, schema, table, opts):
        raise NotImplementedError

    def common_values(self, schema, table, column):
        raise NotImplementedError


def _client(config: Config):
    app = Flask(__name__)
    app.register_blueprint(router(config, _UnusedSource()))
    return app.test_client()


def test_empty_config_is_disabled() -> None:
    # PORTING.md hardening item 2: absent config must mean disabled, never
    # "enabled with defaults".
    client = _client(Config())
    for path in ALL_MOUNT_PATHS:
        assert client.get(path).status_code == 404, path


def test_enabled_false_is_disabled() -> None:
    client = _client(Config(enabled=False))
    for path in ALL_MOUNT_PATHS:
        assert client.get(path).status_code == 404, path


def test_enabled_true_enables_routes() -> None:
    client = _client(Config(enabled=True))
    resp = client.get("/__ashurbanipal")
    assert resp.status_code == 200
    assert len(resp.data) > 0
    # spec/protocol.md §5.1/§7: the UI route carries no protocol header.
    assert "x-ashurbanipal-protocol" not in resp.headers
