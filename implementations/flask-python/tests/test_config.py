"""Ports `implementations/rust/core/src/config.rs`'s test suite. The
no-config (`Config()`) and enabled-absent-from-TOML cases specifically
cover `PORTING.md` hardening item 2 — conformance can't observe either
over HTTP, so this is the only evidence for the "absent config MUST mean
disabled" property.
"""

from ashurbanipal.config import Config


def test_disabled_by_default() -> None:
    assert not Config().is_enabled()


def test_disabled_when_config_absent() -> None:
    # Malformed/incomplete config (no `enabled` key at all) must fail
    # closed, not silently enable via some other default.
    config = Config.from_toml("")
    assert not config.is_enabled()


def test_enabled_when_explicitly_set() -> None:
    config = Config.from_toml("enabled = true")
    assert config.is_enabled()


def test_parses_full_config() -> None:
    config = Config.from_toml(
        """
        enabled = true

        [limits]
        default_page_size = 25
        max_page_size = 50
        query_timeout_secs = 3

        [[siblings]]
        name = "billing"
        dbviewer_url = "https://billing.internal.vpn/__ashurbanipal"
        health_path = "/health"
        """
    )
    assert config.is_enabled()
    assert config.limits.max_page_size == 50
    assert len(config.siblings) == 1


def test_defaults_applied() -> None:
    config = Config.from_toml("enabled = true")
    assert config.limits.default_page_size == 50
    assert config.limits.max_page_size == 100
    assert config.limits.query_timeout_secs == 5
    assert config.siblings == []
