"""Ports `implementations/rust/src/config.rs`'s test suite. The no-config
(`Config()`) and enabled_for-absent-from-TOML cases specifically cover
`PORTING.md` hardening item 2 — conformance can't observe either over
HTTP, so this is the only evidence for the "absent config MUST mean
disabled" property.
"""

import pytest

from ashurbanipal.config import Config, ProductionEnabledError


def test_default_config_is_disabled() -> None:
    # PORTING.md hardening item 2: absent config must mean disabled, never
    # "enabled with defaults" — this is the no-config case itself, not the
    # named-production-alias-rejection case.
    assert Config().is_enabled() is False


@pytest.mark.parametrize("alias", ["production", "prod", "PROD", "Production", "PRD", "live"])
def test_production_aliases_rejected_at_construction(alias: str) -> None:
    with pytest.raises(ProductionEnabledError):
        Config(environment="dev", enabled_for=["dev", alias])


@pytest.mark.parametrize("alias", ["production", "prod", "PROD", "Production", "PRD", "live"])
def test_production_aliases_rejected_from_toml(alias: str) -> None:
    with pytest.raises(ProductionEnabledError):
        Config.from_toml(f'environment = "dev"\nenabled_for = ["dev", "{alias}"]')


@pytest.mark.parametrize("env", ["uat", "sit", "int", "stagin", "qa-eu-1"])
def test_any_non_production_token_accepted(env: str) -> None:
    config = Config.from_toml(f'environment = "{env}"\nenabled_for = ["{env}"]')
    assert config.is_enabled()


def test_parses_full_config() -> None:
    config = Config.from_toml(
        """
        environment = "dev"
        enabled_for = ["dev", "integration", "staging"]

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


def test_disabled_when_environment_not_listed() -> None:
    assert not Config(environment="staging", enabled_for=["dev"]).is_enabled()
    assert not Config(environment="dev", enabled_for=[]).is_enabled()


def test_disabled_when_enabled_for_absent_from_config() -> None:
    # Malformed/incomplete config (no enabled_for key at all) must fail
    # closed, not silently enable via some other default.
    config = Config.from_toml('environment = "dev"')
    assert not config.is_enabled()


def test_enabled_case_insensitively() -> None:
    assert Config(environment="DEV", enabled_for=["dev"]).is_enabled()
    assert Config(environment="staging", enabled_for=["STAGING"]).is_enabled()


def test_any_excludes_production_like_environments() -> None:
    assert Config(environment="dev", enabled_for=["any"]).is_enabled()
    assert Config(environment="staging", enabled_for=["any"]).is_enabled()
    assert not Config(environment="production", enabled_for=["any"]).is_enabled()
    assert not Config(environment="PROD", enabled_for=["any"]).is_enabled()


def test_defaults_applied() -> None:
    config = Config.from_toml('environment = "dev"\nenabled_for = ["dev"]')
    assert config.limits.default_page_size == 50
    assert config.limits.max_page_size == 100
    assert config.limits.query_timeout_secs == 5
    assert config.siblings == []


def test_missing_environment_key_raises() -> None:
    with pytest.raises(ValueError):
        Config.from_toml("")
