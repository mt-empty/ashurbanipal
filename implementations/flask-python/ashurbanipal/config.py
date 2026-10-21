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
class Instance:
    """This instance's own name and label. Labels are opaque host strings:
    echoed, never parsed or acted on (`spec/protocol.md` §4)."""

    name: str
    label: str


@dataclass
class Sibling:
    name: str
    base_url: str
    health_path: str
    label: str | None = None


@dataclass
class Config:
    enabled: bool = False
    limits: Limits = field(default_factory=Limits)
    instance: Instance | None = None
    siblings: list[Sibling] = field(default_factory=list)

    def is_enabled(self) -> bool:
        return self.enabled

    def validate_siblings(self) -> None:
        """The instance/label rules of spec/protocol.md §5.6; raises ValueError."""
        if self.instance is not None and not (self.instance.name and self.instance.label):
            raise ValueError("instance needs a non-empty name and label")
        seen: set[tuple[str, str | None]] = set()
        for s in self.siblings:
            if s.label == "":
                raise ValueError(f"sibling {s.name!r} has an empty label; omit it instead")
            if (s.name, s.label) in seen:
                raise ValueError(f"two siblings share the name {s.name!r} and the same label")
            seen.add((s.name, s.label))

    def is_instance(self, s: Sibling) -> bool:
        """Whether `s` is this instance's own entry, which is reported healthy
        without a health check: it is serving the response."""
        i = self.instance
        return i is not None and (s.name, s.label) == (i.name, i.label)

    @classmethod
    def from_toml(cls, text: str) -> Config:
        data = tomllib.loads(text)
        limits_data = data.get("limits", {})
        siblings_data = data.get("siblings", [])
        instance_data = data.get("instance")
        return cls(
            enabled=bool(data.get("enabled", False)),
            limits=Limits(**limits_data),
            instance=Instance(**instance_data) if instance_data is not None else None,
            siblings=[Sibling(**s) for s in siblings_data],
        )
