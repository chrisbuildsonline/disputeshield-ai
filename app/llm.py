"""Which model answers (Ollama by default, Claude optionally, or none) and the one Ollama chat call."""

from __future__ import annotations

import os
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

DEFAULT_OLLAMA_HOST = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "qwen3:8b"  # the qwen3:4b tag is thinking-only: ~45 s per note, think:false is ignored
_TIMEOUT = httpx.Timeout(90.0, connect=3.0)


def provider() -> Literal["ollama", "claude", "off"]:
    """DISPUTESHIELD_LLM: ollama (default, also for unknown values) | claude (needs ANTHROPIC_API_KEY) | off."""
    v = os.environ.get("DISPUTESHIELD_LLM", "").strip().lower()
    if v == "off":
        return "off"
    if v == "claude":
        return "claude" if os.environ.get("ANTHROPIC_API_KEY") else "off"
    return "ollama"


def ollama_host() -> str:
    raw = os.environ.get("OLLAMA_HOST", "").strip()
    try:
        u = urlsplit(raw)
        if u.scheme in ("http", "https") and u.hostname:
            u.port  # noqa: B018 - raises ValueError on a bad port
            return raw.rstrip("/")
    except ValueError:
        pass
    return DEFAULT_OLLAMA_HOST


def ollama_model() -> str:
    return os.environ.get("DISPUTESHIELD_OLLAMA_MODEL", "").strip() or DEFAULT_OLLAMA_MODEL


def ollama_chat(prompt: str, schema: dict[str, Any] | None = None) -> tuple[str, str]:
    """One non-streaming, temperature 0, no-thinking chat turn; return (reply text, model that answered)."""
    body: dict[str, Any] = {
        "model": ollama_model(),
        "messages": [{"role": "user", "content": prompt + "\n/no_think"}],  # think:false is ignored by some qwen3 builds
        "stream": False,
        "think": False,
        "options": {"temperature": 0},
    }
    if schema is not None:
        body["format"] = schema
    resp = httpx.post(f"{ollama_host()}/api/chat", json=body, timeout=_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    reply = str(data["message"]["content"]).rpartition("</think>")[2].strip()  # drop any leaked reasoning
    return reply, str(data.get("model") or body["model"])
