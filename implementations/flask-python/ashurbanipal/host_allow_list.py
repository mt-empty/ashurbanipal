"""The optional `Host` allow-list against DNS rebinding (`spec/protocol.md` §3.1)."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

_IPV6 = re.compile(r"\[[0-9A-Fa-f:.]+\]")
_REG_NAME = re.compile(r"[A-Za-z0-9._-]+")
_PORT = re.compile(r"[0-9]{1,5}")


@dataclass(frozen=True)
class _HostPort:
    name: str  # lowercased; an IPv6 literal keeps its brackets
    port: int | None


@dataclass
class HostAllowList:
    # None when `allowed_hosts` is absent or empty: every Host passes. Entries
    # that fail to parse are dropped, so a list of only bad entries is empty
    # and rejects every request.
    entries: list[_HostPort] | None
    warnings: list[str] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return self.entries is not None

    @classmethod
    def build(cls, hosts: Sequence[str]) -> HostAllowList:
        if not hosts:
            return cls(
                entries=None,
                warnings=[
                    "allowed_hosts is not set, so any Host header is accepted and a "
                    "DNS-rebinding page can read the viewer (spec/protocol.md §3.1)"
                ],
            )
        entries: list[_HostPort] = []
        warnings: list[str] = []
        for entry in hosts:
            parsed = _parse_host_port(entry) if isinstance(entry, str) else None
            if parsed is None:
                warnings.append(
                    f'allowed_hosts entry "{entry}" is not a host name with an optional port, '
                    "so it matches nothing"
                )
            else:
                entries.append(parsed)
        return cls(entries=entries, warnings=warnings)

    def allows(self, host: str | None) -> bool:
        """`host` is the raw `Host` header, never a forwarded one; with the
        check on, a missing or malformed one is rejected."""
        if self.entries is None:
            return True
        req = _parse_host_port(host) if host is not None else None
        if req is None:
            return False
        return any(e.name == req.name and (e.port is None or e.port == req.port) for e in self.entries)


def _parse_host_port(text: str) -> _HostPort | None:
    """`name` or `name:port`, with an IPv6 literal in brackets; one trailing
    dot on the name is dropped. No scheme, path, userinfo or wildcard."""
    port: str | None
    if text.startswith("["):
        end = text.find("]")
        if end < 0:
            return None
        name, rest = text[: end + 1], text[end + 1 :]
        if not _IPV6.fullmatch(name):
            return None
        if rest and not rest.startswith(":"):
            return None
        port = rest[1:] if rest else None
    else:
        name, sep, after = text.partition(":")
        port = after if sep else None
        # billing.internal. is the same DNS name as billing.internal.
        name = name.removesuffix(".")
        if not _REG_NAME.fullmatch(name):
            return None
    if port is None:
        return _HostPort(name.lower(), None)
    if not _PORT.fullmatch(port) or int(port) > 65535:
        return None
    return _HostPort(name.lower(), int(port))
