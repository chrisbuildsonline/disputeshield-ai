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


# real attempts, in order, until one note passes the runtime checks: (model, ollama options)
ATTEMPTS: list[tuple[str, dict[str, Any]]] = [
    ("qwen3:8b", {"temperature": 0}),
    *[("qwen3:8b", {"temperature": 0.3, "seed": seed}) for seed in (1, 2, 3)],
    ("qwen2.5:3b", {"temperature": 0}),
    ("qwen2.5:7b", {"temperature": 0}),
    ("qwen2.5:14b", {"temperature": 0}),
    ("qwen3:4b", {"temperature": 0}),
]


def _chat(prompt: str, model: str, options: dict[str, Any]) -> tuple[str, str]:
    """The app's note call (llm.ollama_chat) with a chosen model and sampling; returns (text, model that answered)."""
    resp = httpx.post(
        f"{llm.ollama_host()}/api/chat",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt + "\n/no_think"}],
            "stream": False,
            "think": False,
            "options": options,
        },
        timeout=llm._TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    return str(data["message"]["content"]).rpartition("</think>")[2].strip(), str(data.get("model") or model)


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
        prompt = ds._PROMPT + ds._facts(dispute, evs, result)
        found = None
        for n, (model_name, options) in enumerate(ATTEMPTS, 1):
            try:
                text, model = _chat(prompt, model_name, options)
            except Exception as e:
                print(f"      {s.key} attempt {n} {model_name} {options}: failed {type(e).__name__}")
                continue
            text = ds._truncate(text)
            bad = ds.fact_check(text, dispute, evs)
            if text and not bad and not ds._CONCEDES_RE.search(text):
                found = (text, model, n, options)
                break
            print(f"      {s.key} attempt {n} {model_name} {options}: rejected {bad[:3] or 'concedes'}")
        if found is None:
            failed += 1
            print(f"skip  {s.key}: no note passed in {len(ATTEMPTS)} attempts; the template stays")
            continue
        text, model, n, options = found
        notes[recorded.facts_key(ds._facts(dispute, evs, result))] = {
            "scenario": s.key, "note": text, "model": model, "recorded_at": stamp,
        }
        print(f"note  {s.key} ({model}, attempt {n}, options {options})")
    _save(pdfs, notes)
    print(f"{len(pdfs)} reads, {len(notes)} notes, {failed} rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
