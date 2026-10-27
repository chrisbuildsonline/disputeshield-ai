"""Load the repo's .env (gitignored) into os.environ for tests. Stdlib only; never prints values."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


def _load_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        if key and value:
            os.environ.setdefault(key, value)


_load_env(Path(__file__).resolve().parent.parent / ".env")


@pytest.fixture(autouse=True)
def llm_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fallbacks only by default; tests that want a model set DISPUTESHIELD_LLM themselves."""
    monkeypatch.setenv("DISPUTESHIELD_LLM", "off")
