"""Fail-closed kill switch config (`spec/protocol.md` §4). Mirrors
`implementations/rust/src/config.rs`: `Config()`'s own defaults (no
`environment`, empty `enabled_for`) MUST be disabled, and a production-like
`enabled_for` entry MUST raise at construction, never at request time.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field

# Compared case-insensitively; "production" itself is deliberately not
# representable in enabled_for — Config raises at construction rather than
# letting it reach a running server.
_PRODUCTION_ALIASES = ("production", "prod", "prd", "live")


def _is_production_like(value: str) -> bool:
    return value.lower() in _PRODUCTION_ALIASES


class ProductionEnabledError(ValueError):
    def __init__(self, value: str):
        self.value = value
        super().__init__(f"ashurbanipal must never be enabled in production: enabled_for contains {value!r}")


@dataclass
class Limits:
    default_page_size: int = 50
    max_page_size: int = 100
    query_timeout_secs: int = 5


@dataclass
class Sibling:
    name: str
    dbviewer_url: str
    health_path: str


@dataclass
class Config:
    """The zero-argument `Config()` is disabled by construction:
    `enabled_for` is empty, so `is_enabled()` is False regardless of
    `environment` — a host that forgets to configure anything gets a
    404'd viewer, never one silently enabled with defaults.
    """

    environment: str = ""
    enabled_for: list[str] = field(default_factory=list)
    limits: Limits = field(default_factory=Limits)
    siblings: list[Sibling] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        for value in self.enabled_for:
            if _is_production_like(value):
                raise ProductionEnabledError(value)

    def is_enabled(self) -> bool:
        """ "any" matches every environment except production-like ones."""
        if _is_production_like(self.environment):
            return False
        env = self.environment.lower()
        return any(e.lower() in ("any", env) for e in self.enabled_for)

    @classmethod
    def from_toml(cls, text: str) -> "Config":
        data = tomllib.loads(text)
        if "environment" not in data:
            raise ValueError('ashurbanipal config: missing required key "environment"')
        limits_data = data.get("limits", {})
        siblings_data = data.get("siblings", [])
        return cls(
            environment=data["environment"],
            enabled_for=list(data.get("enabled_for", [])),
            limits=Limits(**limits_data),
            siblings=[Sibling(**s) for s in siblings_data],
        )
