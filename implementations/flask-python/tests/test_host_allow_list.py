"""The optional `Host` allow-list (`spec/protocol.md` §3.1)."""

import json

import pytest
from flask import Flask

from ashurbanipal.config import Config
from ashurbanipal.host_allow_list import HostAllowList
from ashurbanipal.routes import router
from tests._catalog_fixture import FIXTURES_DIR
from tests.test_killswitch import _client, _UnusedSource

_FIXTURE_CASES = json.loads((FIXTURES_DIR / "host-allow-list-tests.json").read_text())["cases"]


@pytest.mark.parametrize("case", _FIXTURE_CASES, ids=[c["name"] for c in _FIXTURE_CASES])
def test_shared_fixture_case(case: dict) -> None:
    assert HostAllowList.build(case["allowed_hosts"]).allows(case["host"]) is case["allowed"]


def test_warnings() -> None:
    assert len(HostAllowList.build([]).warnings) == 1
    assert "allowed_hosts is not set" in HostAllowList.build([]).warnings[0]
    warnings = HostAllowList.build(
        ["http://localhost", "localhost/x", "*.example", "localhost:abc", "ok.example"]
    ).warnings
    assert len(warnings) == 4
    assert '"http://localhost"' in warnings[0]


def test_absent_list_logs_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    router(Config(enabled=True), [("primary", _UnusedSource())])
    assert "allowed_hosts is not set" in caplog.text


def test_config_reads_allowed_hosts_from_toml() -> None:
    config = Config.from_toml('enabled = true\nallowed_hosts = ["localhost:4000"]')
    assert config.allowed_hosts == ["localhost:4000"]


def test_a_lone_string_is_one_entry() -> None:
    config = Config.from_toml('allowed_hosts = "billing.internal"')
    assert config.allowed_hosts == ["billing.internal"]
    assert Config(allowed_hosts="billing.internal").allowed_hosts == ["billing.internal"]  # type: ignore[arg-type]


def test_a_non_list_value_warns_and_matches_nothing() -> None:
    hosts = HostAllowList.build(Config.from_toml("allowed_hosts = 4000").allowed_hosts)
    assert hosts.active
    assert len(hosts.warnings) == 1
    assert not hosts.allows("localhost")


def test_an_unlisted_host_gets_a_bare_404() -> None:
    client = _client(Config(enabled=True, allowed_hosts=["localhost"]))
    for path in ["/__ashurbanipal", "/__ashurbanipal/api/tables"]:
        for headers in [{"Host": "rebind.invalid"}, {"Host": "rebind.invalid", "X-Forwarded-Host": "localhost"}]:
            resp = client.get(path, headers=headers)
            assert resp.status_code == 404, (path, headers)
            assert "x-ashurbanipal-protocol" not in resp.headers, (path, headers)
    assert client.get("/__ashurbanipal", headers={"Host": "LOCALHOST:4000"}).status_code == 200


def _app(**register: str) -> Flask:
    app = Flask(__name__)

    @app.get("/other")
    def other() -> str:
        return "host route"

    bp = router(Config(enabled=True, allowed_hosts=["localhost"]), [("primary", _UnusedSource())], mount="/viewer")
    app.register_blueprint(bp, **register)
    return app


def test_a_wrong_method_from_an_unlisted_host_gets_404_not_405() -> None:
    client = _app().test_client()
    resp = client.post("/viewer/api/tables", headers={"Host": "rebind.invalid"})
    assert resp.status_code == 404
    assert "Allow" not in resp.headers


@pytest.mark.parametrize(("register", "mount"), [({}, "/viewer"), ({"url_prefix": "/svc/db"}, "/svc/db")])
def test_the_check_follows_a_custom_mount(register: dict[str, str], mount: str) -> None:
    client = _app(**register).test_client()
    assert client.get(mount, headers={"Host": "rebind.invalid"}).status_code == 404
    assert client.get(f"{mount}/api/tables", headers={"Host": "rebind.invalid"}).status_code == 404
    assert client.get(mount, headers={"Host": "localhost"}).status_code == 200
    # The host's own routes are never checked.
    assert client.get("/other", headers={"Host": "rebind.invalid"}).status_code == 200


def test_api_headers_follow_a_url_prefix_override() -> None:
    app = Flask(__name__)
    app.register_blueprint(router(Config(enabled=True), [("primary", _UnusedSource())]), url_prefix="/svc/db")
    resp = app.test_client().get("/svc/db/api/sources")
    assert resp.status_code == 200
    assert resp.headers["x-ashurbanipal-protocol"] == "1"
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
