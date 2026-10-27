"""Local model (Ollama) path: provider selection, extraction, rebuttal note. httpx is mocked; no server needed."""

from __future__ import annotations

import json
import logging
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from app import llm
from app.dossier import build_dossier
from app.extract import extract, to_evidence
from app.scoring import INR, Dispute, score

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
UPS = (SAMPLES / "ups_receipt.pdf").read_bytes()
CRM = (SAMPLES / "crm_order.pdf").read_bytes()
DISPUTE = Dispute(reason=INR, amount=Decimal("49.90"), billing_address="12 High Street, Leeds LS1 4AB")
GOOD = {"carrier": "UPS", "tracking_number": "1Z999AA10123456784", "signed_by": "J Smith"}


def fake_chat(
    monkeypatch: pytest.MonkeyPatch, content: str | dict[str, Any] | None = None, *, status: int = 200, exc: Exception | None = None
) -> list[dict[str, Any]]:
    """Replace httpx.post; return the list of request kwargs it saw."""
    seen: list[dict[str, Any]] = []

    def post(url: str, **kw: Any) -> httpx.Response:
        seen.append({"url": url, **kw})
        if exc:
            raise exc
        text = content if isinstance(content, str) else json.dumps(content)
        return httpx.Response(
            status, json={"model": "qwen3:test", "message": {"role": "assistant", "content": text}}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx, "post", post)
    return seen


def use_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    monkeypatch.delenv("OLLAMA_HOST", raising=False)


# ---- provider selection ----


def test_default_provider_is_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPUTESHIELD_LLM")
    assert llm.provider() == "ollama"


@pytest.mark.parametrize(
    "value,key,expected",
    [
        ("ollama", None, "ollama"),
        ("off", "sk-test", "off"),
        ("claude", "sk-test", "claude"),
        ("claude", None, "off"),  # no key, no Claude
        ("CLAUDE ", "sk-test", "claude"),
        ("", None, "ollama"),
        ("banana", "sk-test", "ollama"),
    ],
)
def test_provider_selection(monkeypatch: pytest.MonkeyPatch, value: str, key: str | None, expected: str) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", value)
    if key:
        monkeypatch.setenv("ANTHROPIC_API_KEY", key)
    else:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert llm.provider() == expected


def test_ollama_host_default_and_custom(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    assert llm.ollama_host() == "http://localhost:11434"
    monkeypatch.setenv("OLLAMA_HOST", "http://gpu-box:11434/")
    assert llm.ollama_host() == "http://gpu-box:11434"


@pytest.mark.parametrize("bad", ["", "placeholder", "0.0.0.0", "localhost:11434", "ftp://x", "http://", "https:///x", "${OLLAMA_HOST}"])
def test_invalid_ollama_host_uses_default(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    monkeypatch.setenv("OLLAMA_HOST", bad)
    assert llm.ollama_host() == "http://localhost:11434"


def test_ollama_model_default_is_qwen3(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPUTESHIELD_OLLAMA_MODEL", raising=False)
    assert llm.ollama_model().startswith("qwen3")
    monkeypatch.setenv("DISPUTESHIELD_OLLAMA_MODEL", "qwen3:8b")
    assert llm.ollama_model() == "qwen3:8b"


# ---- extraction ----


def test_ollama_extraction_success(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    seen = fake_chat(monkeypatch, GOOD)
    r = extract(UPS)
    assert (r.source, r.model) == ("ollama", "qwen3:test")
    assert r.tracking_number == "1Z999AA10123456784" and r.carrier == "UPS"
    req = seen[0]
    assert req["url"] == "http://localhost:11434/api/chat"
    body = req["json"]
    assert body["stream"] is False and body["think"] is False and body["options"]["temperature"] == 0
    assert body["format"]["type"] == "object" and "tracking_number" in body["format"]["properties"]
    assert "1Z999AA10123456784" in json.dumps(body["messages"])  # the pypdf text is what the model reads
    assert req["timeout"].connect == 3 and req["timeout"].read == 90


def test_ollama_extraction_id_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, {"tracking_number": "1Z000000000000000X", "order_id": "ZZ-999", "signed_by": "J Smith"})
    r = extract(UPS)
    assert r.source == "ollama"
    assert r.order_id is None and r.signed_by == "J Smith"
    assert r.tracking_number == "1Z999AA10123456784"  # the invented id is dropped; the regex value from the text fills in


def test_ollama_extraction_fills_gaps_from_regex_and_drops_junk(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, {"carrier": "null", "tracking_number": "1Z9:999AA10123456784", "amount": "https://ups.com", "signed_by": "J Smith"})
    r = extract(UPS)
    assert r.source == "ollama"
    assert r.carrier == "UPS" and r.amount == "49.90"  # model said "null" / junk: the regex value fills the gap
    assert r.tracking_number == "1Z999AA10123456784"  # garbled id: dropped by the guard, replaced by the text's own
    assert r.signed_by == "J Smith"


def test_labelled_regex_ids_override_wrong_model_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, {"tracking_number": "Delivered", "order_id": "2026-09-28", "carrier": "UPS"})  # "Delivered" is in the UPS text
    assert extract(UPS).tracking_number == "1Z999AA10123456784"
    fake_chat(monkeypatch, {"tracking_number": "PayPal", "order_id": "2026-09-28"})
    crm = extract(CRM)
    assert crm.order_id == "A-1042" and crm.tracking_number == "PayPal"  # no labelled tracking line: the model's value stays


def test_ollama_extraction_empty_pdf_text_skips_model(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    seen = fake_chat(monkeypatch, GOOD)
    assert extract(b"%PDF-1.4\ngarbage").source == "fallback"
    assert seen == []


def test_ollama_not_used_when_use_llm_false(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    seen = fake_chat(monkeypatch, GOOD)
    assert extract(UPS, use_llm=False).source == "fallback"
    assert seen == []


@pytest.mark.parametrize(
    "kwargs",
    [
        {"exc": httpx.ReadTimeout("slow")},
        {"exc": httpx.ConnectError("refused")},
        {"content": "boom", "status": 500},
        {"content": "this is not json"},
        {"content": {"customer_messages": "not a list"}},
        {"content": ""},
    ],
)
def test_ollama_extraction_failure_falls_back_with_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, kwargs: dict[str, Any]
) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, **kwargs)
    with caplog.at_level(logging.WARNING, logger="app.extract"):
        r = extract(UPS)
    assert r.source == "fallback" and r.tracking_number == "1Z999AA10123456784"
    warnings = [x for x in caplog.records if x.levelname == "WARNING" and x.name == "app.extract"]
    assert len(warnings) == 1 and "using fallback" in warnings[0].getMessage()


# ---- rebuttal note ----


def _dossier(use_llm: bool = True) -> Any:
    evs = [extract(UPS, use_llm=False)]
    return build_dossier(DISPUTE, evs, score(DISPUTE, to_evidence(evs[0])), [], use_llm=use_llm)


def test_ollama_note_success(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    seen = fake_chat(monkeypatch, "Tracking 1Z999AA10123456784 was delivered to the billing address.")
    d = _dossier()
    assert d.note_source == "ollama" and d.note_model == "qwen3:test"
    assert d.input["evidences"][0]["notes"].startswith("Tracking 1Z999AA10123456784")
    body = seen[0]["json"]
    assert body["think"] is False and body["stream"] is False and "format" not in body


def test_ollama_note_drops_leaked_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, "Let me think about 2:00:00 and 1ZFAKE.\n</think>\n\nParcel 1Z999AA10123456784 was delivered to the billing address.")
    d = _dossier()
    assert d.note_source == "ollama"
    assert d.input["evidences"][0]["notes"] == "Parcel 1Z999AA10123456784 was delivered to the billing address."


def test_ollama_note_fact_check_rejection_uses_template(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, "Tracking 1ZFAKE0000000000 was delivered.")
    with caplog.at_level(logging.WARNING, logger="app.dossier"):
        d = _dossier()
    assert d.note_source == "template" and d.note_model is None
    assert "1ZFAKE" not in d.input["evidences"][0]["notes"]
    assert any("fact check" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("kwargs", [{"exc": httpx.ReadTimeout("slow")}, {"content": "x", "status": 503}, {"content": "  "}])
def test_ollama_note_failure_uses_template(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, kwargs: dict[str, Any]) -> None:
    use_ollama(monkeypatch)
    fake_chat(monkeypatch, **kwargs)
    with caplog.at_level(logging.WARNING, logger="app.dossier"):
        d = _dossier()
    assert d.note_source == "template"
    assert any(r.levelname == "WARNING" for r in caplog.records)


def test_note_skips_model_when_use_llm_false(monkeypatch: pytest.MonkeyPatch) -> None:
    use_ollama(monkeypatch)
    seen = fake_chat(monkeypatch, "x")
    assert _dossier(use_llm=False).note_source == "template"
    assert seen == []
