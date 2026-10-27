from __future__ import annotations

import logging
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app import dossier as ds
from app.dossier import MAX_NOTES, Dossier, build_dossier, fact_check, template_note
from app.extract import ExtractedEvidence, extract, to_evidence
from app.scoring import INR, SNAD, Dispute, score

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
UPS = (SAMPLES / "ups_receipt.pdf").read_bytes()
CRM = (SAMPLES / "crm_order.pdf").read_bytes()
ADDR = "12 High Street, Leeds LS1 4AB"
DISPUTE = Dispute(reason=INR, amount=Decimal("49.90"), billing_address=ADDR)
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20


def _sample_evidence() -> list[ExtractedEvidence]:
    return [extract(UPS, use_llm=False), extract(CRM, use_llm=False)]


def _build(
    evs: list[ExtractedEvidence] | None = None,
    docs: list[tuple[str, bytes]] | None = None,
    dispute: Dispute = DISPUTE,
    use_llm: bool = False,
) -> Dossier:
    evs = _sample_evidence() if evs is None else evs
    result = score(dispute, to_evidence(evs[0])) if evs else score(dispute, to_evidence(ExtractedEvidence()))
    return build_dossier(dispute, evs, result, docs or [], use_llm=use_llm)


# ---- schema and limits ----


def test_payload_schema_for_sample_evidence() -> None:
    d = _build(docs=[("ups_receipt.pdf", UPS), ("crm_order.pdf", CRM)])
    ev = d.input["evidences"]
    assert len(ev) == 1
    e = ev[0]
    assert e["evidence_type"] == "PROOF_OF_FULFILLMENT"
    assert e["evidence_info"]["tracking_info"] == [{"carrier_name": "UPS", "tracking_number": "1Z999AA10123456784"}]
    assert 1 <= len(e["notes"]) <= MAX_NOTES
    assert [x["name"] for x in e["documents"]] == ["ups_receipt.pdf", "crm_order.pdf"]
    assert [n for n, _ in d.files] == ["ups_receipt.pdf", "crm_order.pdf"]
    assert d.note_source == "template" and d.note_model is None
    assert set(d.input) == {"evidences"}


def test_no_documents_key_when_no_files() -> None:
    assert "documents" not in _build().input["evidences"][0]


def test_oversized_note_is_truncated_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    long_note = ("Delivered to the billing address. " * 200).strip()
    monkeypatch.setattr(ds, "_claude_note", lambda *_: (long_note, "m"))
    d = _build(use_llm=True)
    notes = d.input["evidences"][0]["notes"]
    assert d.note_source == "claude"
    assert len(notes) <= MAX_NOTES
    assert notes.endswith("address.")


@pytest.mark.parametrize(
    "name,data",
    [
        ("a.exe", b"MZ" + b"0" * 10),
        ("a.pdf", PNG),  # content does not match extension
        ("a.png", b""),
        ("noext", PNG),
        ("bad/name.png", PNG),
        ("a.png\n", PNG),  # `$` would accept a trailing newline
        ("a\nb.png", PNG),
    ],
)
def test_bad_files_rejected(name: str, data: bytes) -> None:
    with pytest.raises(ValueError):
        _build(docs=[(name, data)])


def test_file_too_big_rejected() -> None:
    with pytest.raises(ValueError, match="10 MB"):
        _build(docs=[("big.png", PNG + b"0" * (10 * 1024 * 1024))])


def test_total_size_rejected() -> None:
    chunk = PNG + b"0" * (9 * 1024 * 1024)
    with pytest.raises(ValueError, match="50 MB"):
        _build(docs=[(f"f{i}.png", chunk) for i in range(6)])


def test_duplicate_file_names_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        _build(docs=[("a.png", PNG), ("a.png", PNG)])


# ---- evidence_type table ----


@pytest.mark.parametrize(
    "reason,carrier,tracking,expected",
    [
        (INR, "UPS", "1Z1", "PROOF_OF_FULFILLMENT"),
        (INR, "UPS", None, "OTHER"),
        (INR, None, "1Z1", "OTHER"),
        (INR, None, None, "OTHER"),
        (SNAD, "UPS", "1Z1", "OTHER"),
        ("whatever", "UPS", "1Z1", "OTHER"),
    ],
)
def test_evidence_type_selection(reason: str, carrier: str | None, tracking: str | None, expected: str) -> None:
    d = _build([ExtractedEvidence(carrier=carrier, tracking_number=tracking)], dispute=Dispute(reason, "10.00"))
    assert d.input["evidences"][0]["evidence_type"] == expected


def test_never_proof_of_refund_without_refund_id() -> None:
    d = _build([ExtractedEvidence(customer_messages=["please refund"])])
    assert d.input["evidences"][0]["evidence_type"] != "PROOF_OF_REFUND"
    assert "refund_ids" not in str(d.input)


@pytest.mark.parametrize(
    "carrier,expected,other",
    [
        ("UPS", "UPS", None),
        ("ups", "UPS", None),
        ("FedEx", "FEDEX", None),
        ("USPS", "USPS", None),
        ("DHL", "DHL", None),
        ("Hermes Local", "OTHER", "Hermes Local"),
    ],
)
def test_carrier_mapping(carrier: str, expected: str, other: str | None) -> None:
    d = _build([ExtractedEvidence(carrier=carrier, tracking_number="T123")])
    ti = d.input["evidences"][0]["evidence_info"]["tracking_info"][0]
    assert ti["carrier_name"] == expected
    assert ti.get("carrier_name_other") == other


# ---- fact check ----


def test_fact_check_accepts_real_facts() -> None:
    evs = _sample_evidence()
    note = "Order A-1042 for 49.90 shipped with UPS, tracking 1Z999AA10123456784, delivered 2026-10-01 10:00:00."
    assert fact_check(note, DISPUTE, evs) == []


@pytest.mark.parametrize(
    "note",
    [
        "Shipped under tracking 1Z000000000000000X.",
        "Order ZZ-999 was shipped.",
        "We charged 59.90 for the order.",
        "It was delivered on 2026-11-05.",
        "Delivered at 14:35.",
        "Delivered on October 5, 2026.",
        "Reference 123456 on file.",
    ],
)
def test_fact_check_rejects_invented_facts(note: str) -> None:
    assert fact_check(note, DISPUTE, _sample_evidence()) != []


def test_fact_check_amount_equal_by_value() -> None:
    assert fact_check("Paid 49.9 in total.", DISPUTE, _sample_evidence()) == []


@pytest.mark.parametrize(
    "note",
    [
        "We agreed a refund of $500.",
        "Refund of USD 50 was issued.",
        "Refund of 50 USD was issued.",
        "We refunded €1,000.",
        "We refunded £12.",
        "They paid 500 dollars.",
        "Paid $49.91 in total.",
        "Paid 49 USD in total.",
    ],
)
def test_fact_check_rejects_invented_marked_amounts(note: str) -> None:
    assert fact_check(note, DISPUTE, _sample_evidence()) != []


@pytest.mark.parametrize(
    "note",
    ["Total $49.90.", "Total USD 49.9.", "Total 49.90 USD.", "Total £49.90.", "Total 49.90 dollars."],
)
def test_fact_check_accepts_marked_amounts_equal_by_value(note: str) -> None:
    assert fact_check(note, DISPUTE, _sample_evidence()) == []


def test_template_passes_fact_check_on_samples() -> None:
    evs = _sample_evidence()
    note = template_note(DISPUTE, evs, score(DISPUTE, to_evidence(evs[0])))
    assert 0 < len(note) <= MAX_NOTES
    assert "1Z999AA10123456784" in note and "A-1042" in note
    assert fact_check(note, DISPUTE, evs) == []


def test_hallucinating_claude_falls_back(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(ds, "_claude_note", lambda *_: ("Tracking 1ZFAKE0000000000 was delivered.", "stub"))
    with caplog.at_level("WARNING", logger="app.dossier"):
        d = _build(use_llm=True)
    assert d.note_source == "template"
    assert "1ZFAKE" not in d.input["evidences"][0]["notes"]
    assert any("fact check" in r.getMessage() for r in caplog.records)


def test_claude_error_falls_back(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-value")

    def boom(*_: Any) -> Any:
        raise RuntimeError("upstream exploded")

    monkeypatch.setattr(ds, "_claude_note", boom)
    with caplog.at_level("WARNING", logger="app.dossier"):
        d = _build(use_llm=True)
    assert d.note_source == "template"
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "upstream exploded" in msgs and "sk-secret-value" not in msgs


def test_no_key_uses_template(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(ds, "_claude_note", lambda *_: pytest.fail("should not be called"))
    assert _build(use_llm=True).note_source == "template"


def test_good_claude_note_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(ds, "_claude_note", lambda *_: ("Order A-1042 was delivered to the billing address.", "stub-model"))
    d = _build(use_llm=True)
    assert d.note_source == "claude" and d.note_model == "stub-model"
    assert d.input["evidences"][0]["notes"].startswith("Order A-1042")


def test_empty_evidence_is_valid() -> None:
    d = _build([])
    e = d.input["evidences"][0]
    assert e["evidence_type"] == "OTHER" and e["notes"] and "evidence_info" not in e


# ---- property ----

_txt = st.one_of(st.none(), st.text(max_size=300))


@settings(max_examples=200, deadline=None)
@given(
    st.lists(
        st.builds(
            ExtractedEvidence,
            carrier=_txt,
            tracking_number=_txt,
            delivered_at=_txt,
            delivered_to=_txt,
            signed_by=_txt,
            order_id=_txt,
            amount=_txt,
            customer_messages=st.lists(st.text(max_size=300), max_size=4),
        ),
        max_size=3,
    ),
    st.text(max_size=40),
    st.one_of(st.text(max_size=20), st.decimals(allow_nan=False, allow_infinity=False)),
)
def test_build_never_raises_and_template_passes(evs: list[ExtractedEvidence], reason: str, amount: str | Decimal) -> None:
    dispute = Dispute(reason=reason, amount=amount, billing_address=None)
    d = _build(evs, dispute=dispute)
    e = d.input["evidences"][0]
    assert 1 <= len(e["notes"]) <= MAX_NOTES
    assert d.note_source == "template"
    assert fact_check(e["notes"], dispute, evs) == []
    for ti in e.get("evidence_info", {}).get("tracking_info", []):
        assert ti["carrier_name"] and ti["tracking_number"]


# ---- live ----


def test_live_ollama_note_for_ups_receipt(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")  # real local server, no mocks
    evs = _sample_evidence()
    with caplog.at_level(logging.WARNING, logger="app.dossier"):
        d = _build(evs, docs=[("ups_receipt.pdf", UPS)], use_llm=True)
    notes = d.input["evidences"][0]["notes"]
    print(f"note_source={d.note_source} model={d.note_model}\n{notes}\n{d.notes}")
    assert d.note_source == "ollama", d.notes
    assert d.note_model
    assert fact_check(notes, DISPUTE, evs) == []
