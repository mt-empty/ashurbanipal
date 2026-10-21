"""`/api/siblings` instance and label handling (spec/protocol.md §5.6).

Port 9 refuses at once, so every health check is a fast healthy=false, and
the endpoint never touches the database.
"""

from dataclasses import replace

import pytest
from flask import Flask

from ashurbanipal.config import Config, Instance, Sibling
from ashurbanipal.routes import router
from tests.test_killswitch import _client, _UnusedSource

UNREACHABLE = "http://127.0.0.1:9/__ashurbanipal"


def _labelled() -> Config:
    return Config(
        enabled=True,
        instance=Instance(name="orders", label="dev"),
        siblings=[
            Sibling(name="orders", label="dev", base_url=UNREACHABLE, health_path="/health"),
            Sibling(name="orders", label="int", base_url=UNREACHABLE, health_path="/health"),
            Sibling(name="billing", base_url=UNREACHABLE, health_path="/health"),
        ],
    )


def test_echoes_instance_and_labels_and_leaves_out_this_instance() -> None:
    body = _client(_labelled()).get("/__ashurbanipal/api/siblings").get_json()
    assert body == {
        "instance": {"name": "orders", "label": "dev"},
        "siblings": [
            {"name": "orders", "label": "int", "base_url": UNREACHABLE, "healthy": False},
            {"name": "billing", "base_url": UNREACHABLE, "healthy": False},
        ],
    }


def test_omits_instance_and_label_when_unconfigured() -> None:
    config = Config(enabled=True, siblings=[Sibling(name="billing", base_url=UNREACHABLE, health_path="/health")])
    body = _client(config).get("/__ashurbanipal/api/siblings").get_json()
    assert body == {"siblings": [{"name": "billing", "base_url": UNREACHABLE, "healthy": False}]}


def test_parses_instance_and_labels_from_toml() -> None:
    config = Config.from_toml(
        """
        [instance]
        name = "orders"
        label = "dev"

        [[siblings]]
        name = "orders"
        label = "int"
        base_url = "http://orders-int/__ashurbanipal"
        health_path = "/health"
        """
    )
    assert config.instance == Instance(name="orders", label="dev")
    assert config.siblings[0].label == "int"


def _with_second_label(label: str) -> Config:
    config = _labelled()
    config.siblings[1] = replace(config.siblings[1], label=label)
    return config


@pytest.mark.parametrize(
    "config",
    [
        replace(_labelled(), instance=Instance(name="orders", label="")),
        _with_second_label(""),
        _with_second_label("dev"),
    ],
    ids=["instance without a label", "empty sibling label", "duplicate name and label"],
)
def test_rejects_invalid_sibling_config_when_enabled(config: Config) -> None:
    with pytest.raises(ValueError):
        router(config, [("primary", _UnusedSource())])


def test_never_validates_siblings_when_disabled() -> None:
    config = replace(_labelled(), enabled=False, instance=Instance(name="orders", label=""))
    app = Flask(__name__)
    app.register_blueprint(router(config, [("primary", _UnusedSource())]))
