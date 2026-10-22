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


def test_reports_this_instance_in_place_without_a_check() -> None:
    body = _client(_labelled()).get("/__ashurbanipal/api/siblings").get_json()
    assert body == {
        "instance": {"name": "orders", "label": "dev"},
        "siblings": [
            {"name": "orders", "label": "dev", "base_url": UNREACHABLE, "healthy": True},
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
    ("config", "siblings", "warning"),
    [
        (
            replace(_labelled(), instance=Instance(name="orders", label="")),
            3,
            "instance needs a non-empty name and label; ignored",
        ),
        (_with_second_label(""), 3, 'sibling "orders" has an empty label; treated as unlabelled'),
        (_with_second_label("dev"), 3, 'two siblings share the name "orders" and the label "dev"'),
        (
            replace(_labelled(), siblings=[*_labelled().siblings, _labelled().siblings[2]]),
            4,
            'two siblings share the name "billing" and no label',
        ),
    ],
    ids=[
        "instance without a label",
        "empty sibling label",
        "duplicate name and label",
        "duplicate unlabelled name",
    ],
)
def test_keeps_siblings_and_warns_on_config_mistakes(config: Config, siblings: int, warning: str) -> None:
    resp = _client(config).get("/__ashurbanipal/api/siblings")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body["siblings"]) == siblings
    assert body["warnings"] == [warning]


def test_never_validates_siblings_when_disabled() -> None:
    config = replace(_labelled(), enabled=False, instance=Instance(name="orders", label=""))
    app = Flask(__name__)
    app.register_blueprint(router(config, [("primary", _UnusedSource())]))
