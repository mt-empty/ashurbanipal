"""Fail-closed configuration (`spec/protocol.md` §4)."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, replace


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

    def siblings_view(self) -> SiblingsView:
        """What `/api/siblings` reports; built once, at router construction."""
        warnings: list[str] = []
        instance = self.instance
        if instance is not None and not (instance.name and instance.label):
            warnings.append("instance needs a non-empty name and label; ignored")
            instance = None
        copies: dict[tuple[str, str | None], int] = {}
        siblings = []
        for s in self.siblings:
            if s.label == "":
                warnings.append(f'sibling "{s.name}" has an empty label; treated as unlabelled')
                s = replace(s, label=None)
            key = (s.name, s.label)
            copies[key] = copies.get(key, 0) + 1
            if copies[key] == 2:
                warnings.append(
                    f'two siblings share the name "{s.name}" and no label'
                    if s.label is None
                    else f'two siblings share the name "{s.name}" and the label "{s.label}"'
                )
            siblings.append(s)
        return SiblingsView(instance=instance, siblings=siblings, warnings=warnings)

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


@dataclass
class SiblingsView:
    """The sibling config after spec/protocol.md §5.6's corrections, which
    never reject it: each one is reported in `warnings`."""

    instance: Instance | None
    siblings: list[Sibling]
    warnings: list[str]

    def is_instance(self, s: Sibling) -> bool:
        """Whether `s` is this instance's own entry, which is reported healthy
        without a health check: it is serving the response."""
        i = self.instance
        return i is not None and (s.name, s.label) == (i.name, i.label)
