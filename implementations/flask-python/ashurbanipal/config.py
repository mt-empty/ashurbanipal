"""Fail-closed configuration (`spec/protocol.md` §4)."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field


@dataclass
class Limits:
    default_page_size: int = 50
    max_page_size: int = 100
    query_timeout_secs: int = 5


@dataclass
class Sibling:
    name: str
    base_url: str
    health_path: str


@dataclass
class Config:
    enabled: bool = False
    limits: Limits = field(default_factory=Limits)
    siblings: list[Sibling] = field(default_factory=list)

    def is_enabled(self) -> bool:
        return self.enabled

    @classmethod
    def from_toml(cls, text: str) -> Config:
        data = tomllib.loads(text)
        limits_data = data.get("limits", {})
        siblings_data = data.get("siblings", [])
        return cls(
            enabled=bool(data.get("enabled", False)),
            limits=Limits(**limits_data),
            siblings=[Sibling(**s) for s in siblings_data],
        )
