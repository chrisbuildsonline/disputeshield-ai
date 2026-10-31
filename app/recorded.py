"""Model output recorded once (bun run llm:record) and shipped in samples/recorded.json.

Used only when no live model answers: PDFs are keyed by the sha256 of their bytes, notes by the sha256 of the
facts string the model was given. A missing or malformed file means no recorded reads.
"""

from __future__ import annotations

import hashlib
import json
import logging
from functools import cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PATH = Path(__file__).resolve().parent.parent / "samples" / "recorded.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def facts_key(facts: str) -> str:
    return sha256(facts.encode("utf-8"))


@cache
def load() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(PATH.read_text(encoding="utf-8"))
        pdfs, notes = data["pdfs"], data["notes"]
        if isinstance(pdfs, dict) and isinstance(notes, dict):
            return {"pdfs": pdfs, "notes": notes}
    except Exception as e:
        logger.info("no recorded reads: %s: %s", type(e).__name__, str(e)[:100])
    return {"pdfs": {}, "notes": {}}


def pdf(data: bytes) -> dict[str, Any] | None:
    entry = load()["pdfs"].get(sha256(data))
    return entry if isinstance(entry, dict) and isinstance(entry.get("fields"), dict) else None


def note(facts: str) -> dict[str, Any] | None:
    entry = load()["notes"].get(facts_key(facts))
    return entry if isinstance(entry, dict) and isinstance(entry.get("note"), str) else None
