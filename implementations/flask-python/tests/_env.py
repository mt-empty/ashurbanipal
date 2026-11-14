"""Database URL lookup shared by the integration test modules."""

from __future__ import annotations

import os


def require_env(name: str) -> str | None:
    """The named database URL, or None so the caller skips locally. Under CI a
    missing URL raises, so a CI job that loses the variable fails instead of
    skipping."""
    value = os.environ.get(name)
    if not value and os.environ.get("CI"):
        raise RuntimeError(f"{name} is not set; CI must provide it")
    return value or None
