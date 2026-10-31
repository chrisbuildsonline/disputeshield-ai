"""Record the real model's output once, for the sample PDFs and the demo cases: bun run llm:record.

Writes samples/recorded.json. app/recorded.py serves it only when no live model answers.
Needs a reachable Ollama (the default qwen3:8b); fails loudly rather than record a fallback.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Any

import httpx

from app import demo, llm, recorded, scorecard
from app import dossier as ds
from app import extract as ex
from app.scoring import score

SAMPLES = recorded.PATH.parent
llm._TIMEOUT = httpx.Timeout(900.0, connect=3.0)  # recording may share a busy GPU; the app's 90 s limit would drop reads


def _save(pdfs: dict[str, Any], notes: dict[str, Any]) -> None:
    recorded.PATH.write_text(json.dumps({"pdfs": pdfs, "notes": notes}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    recorded.load.cache_clear()


def main() -> int:
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    pdfs: dict[str, Any] = {}
    for path in sorted(SAMPLES.glob("*.pdf")):
        data = path.read_bytes()
        raw, model = ex._ollama_reply(ex._pdf_text(data))
        pdfs[recorded.sha256(data)] = {"file": path.name, "fields": raw, "model": model, "recorded_at": stamp}
        print(f"read  {path.name} ({model})")
    notes: dict[str, Any] = {}
    _save(pdfs, notes)

    failed = 0
    for s in demo.SCENARIOS:  # the first one is also the walkthrough chargeback
        r = demo.resource(s)
        dispute = scorecard.to_dispute(
            {"reason": s.reason, "amount_value": s.value, "currency": s.currency}, scorecard.billing_of(r)
        )
        evs = [ex.extract((SAMPLES / n).read_bytes(), use_llm=False) for n in s.docs]
        assert all(e.source == "recorded" for e in evs), "the recorded reads did not load"
        result = score(dispute, scorecard.merge(evs))
        text, model = ds._ollama_note(dispute, evs, result)
        text = ds._truncate(text)
        bad = ds.fact_check(text, dispute, evs)
        if bad or ds._CONCEDES_RE.search(text):
            failed += 1
            print(f"skip  {s.key}: note rejected ({bad[:5] or 'concedes'}); the template stays")
            continue
        notes[recorded.facts_key(ds._facts(dispute, evs, result))] = {
            "scenario": s.key, "note": text, "model": model, "recorded_at": stamp,
        }
        print(f"note  {s.key} ({model})")
    _save(pdfs, notes)
    print(f"{len(pdfs)} reads, {len(notes)} notes, {failed} rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
