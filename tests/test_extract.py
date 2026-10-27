from __future__ import annotations

import dataclasses
import re
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app import extract as ex
from app.extract import ExtractedEvidence, extract, parse_text, to_evidence
from app.scoring import INR, Dispute, Evidence, score

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
UPS = (SAMPLES / "ups_receipt.pdf").read_bytes() if (SAMPLES / "ups_receipt.pdf").exists() else b""
CRM = (SAMPLES / "crm_order.pdf").read_bytes() if (SAMPLES / "crm_order.pdf").exists() else b""

ADDR = "12 High Street, Leeds LS1 4AB"


def _norm(s: str | None) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", (s or "").casefold()).split())


def test_samples_exist() -> None:
    assert UPS.startswith(b"%PDF") and CRM.startswith(b"%PDF")


def test_fallback_on_ups_receipt() -> None:
    r = extract(UPS, use_llm=False)
    assert r.source == "fallback"
    assert r.carrier == "UPS"
    assert r.tracking_number == "1Z999AA10123456784"
    assert r.delivered_at == "2026-10-01 10:00:00"
    assert r.delivered_to == ADDR
    assert r.signed_by == "J Smith"
    assert r.order_id is None
    assert r.customer_messages == []


def test_fallback_on_crm_order() -> None:
    r = extract(CRM, use_llm=False)
    assert r.source == "fallback"
    assert r.order_id == "A-1042"
    assert r.amount == "49.90"
    assert r.customer_messages == [
        "Hi, where is my parcel? It has not arrived.",
        "Please confirm the delivery address is correct.",
    ]
    assert r.tracking_number is None
    assert r.signed_by is None


def test_to_evidence_mapping() -> None:
    e = to_evidence(
        ExtractedEvidence(
            carrier="UPS",
            tracking_number="1Z1",
            delivered_at="2026-10-01",
            delivered_to=ADDR,
            signed_by="J Smith",
            order_id="A-1",
            amount="49.90",
            customer_messages=["a", "b"],
            source="fallback",
        )
    )
    assert e == Evidence(
        carrier="UPS",
        tracking_number="1Z1",
        delivered_at="2026-10-01",
        delivered_to=ADDR,
        signed_by="J Smith",
        order_id="A-1",
        amount="49.90",
        customer_messages=("a", "b"),
    )
    assert to_evidence(ExtractedEvidence()) == Evidence()


def _merged() -> Evidence:
    a = to_evidence(extract(UPS, use_llm=False))
    b = to_evidence(extract(CRM, use_llm=False))
    fields = {
        f.name: getattr(a, f.name) or getattr(b, f.name) for f in dataclasses.fields(Evidence)
    }
    return Evidence(**fields)


def test_demo_dispute_scores_from_extracted_evidence() -> None:
    d = Dispute(reason=INR, amount=Decimal("49.90"), billing_address=ADDR)
    merged = _merged()
    # shipping receipt + order amount alone is the 94 demo case ...
    assert score(d, dataclasses.replace(merged, order_id=None)).probability == 94
    # ... and the CRM order id adds the last 6 points
    assert score(d, merged).probability == 100


def test_claude_error_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    def boom(_: bytes) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(ex, "_claude_tool_input", boom)
    r = extract(UPS)
    assert r.source == "fallback"
    assert r.tracking_number == "1Z999AA10123456784"


def test_claude_error_is_logged(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-value")

    def boom(_: bytes) -> Any:
        raise RuntimeError("upstream exploded")

    monkeypatch.setattr(ex, "_claude_tool_input", boom)
    with caplog.at_level("WARNING", logger="app.extract"):
        assert extract(UPS).source == "fallback"
    warnings = [r for r in caplog.records if r.levelname == "WARNING" and r.name == "app.extract"]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert "RuntimeError" in msg and "upstream exploded" in msg
    assert "sk-secret-value" not in msg


def test_claude_invalid_output_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(ex, "_claude_tool_input", lambda _: ({"customer_messages": "not a list"}, "m"))
    assert extract(UPS).source == "fallback"


def test_guard_drops_hallucinated_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake = {
        "carrier": "UPS",
        "tracking_number": "1Z000000000000000X",
        "order_id": "ZZ-999",
        "signed_by": "J Smith",
    }
    monkeypatch.setattr(ex, "_claude_tool_input", lambda _: (fake, "stub-model"))
    r = extract(UPS)
    assert r.source == "claude"
    assert r.model == "stub-model"
    assert r.tracking_number is None
    assert r.order_id is None
    assert r.signed_by == "J Smith"


def test_guard_keeps_real_ids_ignoring_space_and_case(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake = {"tracking_number": "1z 999aa1 0123456784"}
    monkeypatch.setattr(ex, "_claude_tool_input", lambda _: (fake, "stub-model"))
    assert extract(UPS).tracking_number == "1z 999aa1 0123456784"


def test_oversize_rejected() -> None:
    with pytest.raises(ValueError, match="10 MB"):
        extract(b"0" * (10 * 1024 * 1024 + 1), use_llm=False)


@pytest.mark.parametrize("data", [b"", b"not a pdf", b"%PDF-1.4\ngarbage", UPS[: len(UPS) // 2], b"\x00" * 100])
def test_garbage_returns_empty_fallback(data: bytes) -> None:
    r = extract(data, use_llm=False)
    assert r == ExtractedEvidence(source="fallback")


def test_garbage_with_claude_key_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    assert extract(b"junk").source == "fallback"


# ---- fuzz ----


@settings(max_examples=200)
@given(st.text(max_size=2000))
def test_parse_text_never_raises(text: str) -> None:
    r = parse_text(text)
    assert ExtractedEvidence.model_validate(r.model_dump()) == r


@settings(max_examples=100, deadline=None)
@given(st.binary(max_size=4000))
def test_extract_arbitrary_bytes_never_raises(data: bytes) -> None:
    r = extract(data, use_llm=False)
    assert r.source == "fallback"
    ExtractedEvidence.model_validate(r.model_dump())


# ---- live ----


@pytest.mark.parametrize("pdf", [UPS, CRM], ids=["ups_receipt", "crm_order"])
def test_live_ollama_raw_answer_matches_fallback(monkeypatch: pytest.MonkeyPatch, pdf: bytes) -> None:
    """The model's own JSON, before the guard and the regex fill."""
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    text = ex._pdf_text(pdf)
    raw = ex._ollama_raw(text)
    fields = ex.EvidenceFields.model_validate(raw)
    base = parse_text(text)
    print(f"raw model answer: {raw}")
    for name in ("tracking_number", "order_id", "carrier"):
        if getattr(base, name):
            assert _norm(getattr(fields, name)) == _norm(getattr(base, name)), name


@pytest.mark.parametrize("pdf", [UPS, CRM], ids=["ups_receipt", "crm_order"])
def test_live_ollama_matches_fallback(monkeypatch: pytest.MonkeyPatch, pdf: bytes) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")  # real local server, no mocks; first call may load the model
    live = extract(pdf)
    base = extract(pdf, use_llm=False)
    print(f"live model: {live.model}")
    assert live.source == "ollama"
    assert live.model
    for name in ("tracking_number", "order_id", "carrier", "amount"):
        if getattr(base, name):
            assert _norm(getattr(live, name)) == _norm(getattr(base, name)), name
