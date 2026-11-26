"""The viewer never changes a host route (`spec/protocol.md` §3), with the
`Host` check on or off: `spec/fixtures/host-routes-untouched.json`."""

import json

import pytest
from flask import Blueprint, Flask

from ashurbanipal.config import Config
from ashurbanipal.routes import VIEWER_API_PATHS, router
from tests._catalog_fixture import FIXTURES_DIR
from tests.test_killswitch import _UnusedSource

_FIXTURE = json.loads((FIXTURES_DIR / "host-routes-untouched.json").read_text())


def _app(allowed_hosts: list[str], mount: str, routes: list[dict[str, str]], nest: str | None = None) -> Flask:
    app = Flask(__name__)
    for i, route in enumerate(routes):
        app.add_url_rule(route["path"], f"host_{i}", lambda: "host-route", methods=[route["method"]])
    app.register_error_handler(404, lambda _: ("host-404", 404))
    viewer = router(Config(enabled=True, allowed_hosts=allowed_hosts), [("primary", _UnusedSource())])
    if nest is None:
        app.register_blueprint(viewer, url_prefix=mount)
    else:
        parent = Blueprint("parent", __name__, url_prefix=nest)
        parent.register_blueprint(viewer, url_prefix=mount.removeprefix(nest))
        app.register_blueprint(parent)
    return app


def _answers(mount: str, routes: list[dict[str, str]], requests: list[dict[str, str]], nest: str | None = None):
    clients = {
        "listed": (_app(["localhost"], mount, routes, nest).test_client(), "localhost"),
        "unlisted": (_app(["localhost"], mount, routes, nest).test_client(), "rebind.invalid"),
        "check off": (_app([], mount, routes, nest).test_client(), "rebind.invalid"),
    }
    for req in requests:
        got = {
            label: client.open(req["path"], method=req["method"], headers={"Host": host})
            for label, (client, host) in clients.items()
        }
        yield req, {label: (r.status_code, r.get_data(as_text=True)) for label, r in got.items()}


def _expand(entries: list[dict[str, str]], mount: str) -> list[dict[str, str]]:
    return [{**e, "path": e["path"].replace("{mount}", mount)} for e in entries]


@pytest.mark.parametrize(
    ("mount", "nest"), [("/__ashurbanipal", None), ("/svc/db", None), ("/svc/db", "/svc")], ids=str
)
def test_host_routes_are_untouched(mount: str, nest: str | None) -> None:
    routes = _expand(_FIXTURE["host_routes"], mount)
    unrouted = _expand(_FIXTURE["unrouted"], mount)
    for req, answers in _answers(mount, routes, routes, nest):
        assert set(answers.values()) == {(200, "host-route")}, (req, answers)
    for req, answers in _answers(mount, routes, unrouted, nest):
        assert set(answers.values()) == {(404, "host-404")}, (req, answers)


def test_a_root_mount_leaves_the_host_routes_alone(caplog: pytest.LogCaptureFixture) -> None:
    routes = [
        {"method": "GET", "path": "/health"},
        {"method": "GET", "path": "/api/orders"},
        {"method": "GET", "path": "/api/tables/extra"},
        {"method": "POST", "path": "/"},
        {"method": "POST", "path": "/api/tables"},
    ]
    for req, answers in _answers("/", routes, routes):
        assert set(answers.values()) == {(200, "host-route")}, (req, answers)
    unrouted = [{"method": "GET", "path": "/nothing"}, {"method": "GET", "path": "/api/nothing"}]
    for req, answers in _answers("/", routes, unrouted):
        assert set(answers.values()) == {(404, "host-404")}, (req, answers)
    assert "a root mount takes / and /api/..." in caplog.text


def test_viewer_paths_match_the_routes() -> None:
    assert ["", *VIEWER_API_PATHS] == _FIXTURE["viewer_paths"]
    app = Flask(__name__)
    app.register_blueprint(router(Config(enabled=True), [("primary", _UnusedSource())]))
    rules = sorted(
        r.rule.removeprefix("/__ashurbanipal") for r in app.url_map.iter_rules() if r.endpoint != "static"
    )
    assert rules == sorted(_FIXTURE["viewer_paths"])
