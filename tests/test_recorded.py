"""Recorded model reads: shipped for the sample PDFs and notes, used only when no live model answers."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import demo, recorded, scorecard
from app import dossier as ds
from app.extract import ExtractedEvidence, extract
from app.main import app
from app.scoring import INR, Dispute, score
from app.submit import SAMPLES

SHIPPED = Path(recorded.PATH)
UPS = (SAMPLES / "ups_receipt.pdf").read_bytes()
MODEL = "qwen3:8b"
RAW = {
    "carrier": "UPS",
    "tracking_number": "1Z999AA10123456784",
    "delivered_at": "2026-10-01 10:00:00",
    "delivered_to": "12 High Street, Leeds LS1 4AB",
    "signed_by": "J Smith",
    "order_id": "A-1042",
    "amount": "49.90",
    "customer_messages": [],
}


def _write(path: Path, pdfs: dict[str, Any], notes: dict[str, Any]) -> None:
    path.write_text(json.dumps({"pdfs": pdfs, "notes": notes}), encoding="utf-8")
    recorded.load.cache_clear()


@pytest.fixture
def rec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway recorded.json in place of the shipped one (missing until a test writes it)."""
    path = tmp_path / "recorded.json"
    monkeypatch.setattr(recorded, "PATH", path)
    recorded.load.cache_clear()
    return path


@pytest.fixture
def shipped(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real samples/recorded.json."""
    monkeypatch.setattr(recorded, "PATH", SHIPPED)
    recorded.load.cache_clear()


def _record_ups(rec: Path, raw: dict[str, Any] = RAW) -> None:
    key = hashlib.sha256(UPS).hexdigest()
    _write(rec, {key: {"fields": raw, "model": MODEL, "recorded_at": "2026-10-31T00:00:00Z", "file": "ups_receipt.pdf"}}, {})


def test_recorded_read_when_provider_off(rec: Path) -> None:
    _record_ups(rec)
    e = extract(UPS, use_llm=False)
    assert e.source == "recorded" and e.model == MODEL
    assert e.tracking_number == "1Z999AA10123456784" and e.signed_by == "J Smith"


def test_changed_bytes_fall_back_to_regex(rec: Path) -> None:
    _record_ups(rec)
    e = extract(UPS + b"\n%tail", use_llm=False)
    assert e.source == "fallback" and e.model is None


def test_recorded_fields_still_pass_the_guard(rec: Path) -> None:
    _record_ups(rec, {**RAW, "tracking_number": "1ZNOTINTHEPDF000000", "order_id": "Z-9999", "signed_by": "Someone Else"})
    e = extract(UPS, use_llm=False)
    assert e.source == "recorded"
    assert e.tracking_number == "1Z999AA10123456784"  # the invented id was dropped, the regex fill put the real one back
    assert e.order_id == "A-1042"


def test_recorded_used_when_live_model_fails(rec: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _record_ups(rec)
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")
    assert extract(UPS).source == "recorded"


def test_live_model_wins_over_recorded(rec: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _record_ups(rec)
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    monkeypatch.setattr("app.llm.ollama_chat", lambda prompt, schema=None: (json.dumps(RAW), "live-model"))
    e = extract(UPS)
    assert e.source == "ollama" and e.model == "live-model"


@pytest.mark.parametrize("content", [None, "not json", "[]", '{"pdfs": 3, "notes": []}'])
def test_missing_or_malformed_file_behaves_as_today(rec: Path, content: str | None) -> None:
    if content is not None:
        rec.write_text(content, encoding="utf-8")
    recorded.load.cache_clear()
    assert extract(UPS, use_llm=False).source == "fallback"


def test_the_shipped_file_covers_every_sample() -> None:
    data = json.loads(SHIPPED.read_text(encoding="utf-8"))
    for p in SAMPLES.glob("*.pdf"):
        entry = data["pdfs"][hashlib.sha256(p.read_bytes()).hexdigest()]
        assert entry["file"] == p.name and entry["model"] and entry["recorded_at"] and "fields" in entry


@pytest.mark.usefixtures("shipped")
def test_seed_documents_are_all_recorded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    c = TestClient(app)
    sources = [
        doc["evidence"]["source"]
        for x in c.post("/api/demo/seed").json()["disputes"]
        for doc in c.get(f"/api/disputes/{x['id']}/documents").json()
    ]
    assert len(sources) == 6 and set(sources) == {"recorded"}


# ---- notes ----

DISPUTE = Dispute(reason=INR, amount=Decimal("49.90"), billing_address="12 High Street, Leeds LS1 4AB", currency="USD")
GOOD = "We shipped order A-1042 for USD 49.90 with UPS under tracking number 1Z999AA10123456784. Please rule in our favour."


def _ctx() -> tuple[list[ExtractedEvidence], Any]:
    evs = [ExtractedEvidence.model_validate({**RAW, "source": "recorded", "model": MODEL})]
    return evs, score(DISPUTE, scorecard.merge(evs))


def _record_note(rec: Path, text: str) -> None:
    evs, result = _ctx()
    key = recorded.facts_key(ds._facts(DISPUTE, evs, result))
    _write(rec, {}, {key: {"note": text, "model": MODEL, "recorded_at": "2026-10-31T00:00:00Z"}})


def test_recorded_note_after_live_fails(rec: Path) -> None:
    _record_note(rec, GOOD)
    evs, result = _ctx()
    d = ds.build_dossier(DISPUTE, evs, result, use_llm=False)
    assert (d.note_source, d.note_model) == ("recorded", MODEL)
    assert d.input["evidences"][0]["notes"] == GOOD


def test_recorded_note_rejected_by_fact_check(rec: Path) -> None:
    _record_note(rec, "We shipped order B-7777 for USD 49.90. Please rule in our favour.")
    evs, result = _ctx()
    d = ds.build_dossier(DISPUTE, evs, result, use_llm=False)
    assert d.note_source == "template" and any("Recorded" in n for n in d.notes)


def test_recorded_note_rejected_when_it_concedes(rec: Path) -> None:
    _record_note(rec, "We apologise and will refund USD 49.90.")
    evs, result = _ctx()
    assert ds.build_dossier(DISPUTE, evs, result, use_llm=False).note_source == "template"


def test_no_matching_note_is_template(rec: Path) -> None:
    _write(rec, {}, {"0" * 64: {"note": GOOD, "model": MODEL, "recorded_at": "x"}})
    evs, result = _ctx()
    assert ds.build_dossier(DISPUTE, evs, result, use_llm=False).note_source == "template"


def test_live_note_wins_over_recorded(rec: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _record_note(rec, GOOD)
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    live = "We shipped order A-1042 with UPS. Please rule in our favour."
    monkeypatch.setattr("app.llm.ollama_chat", lambda prompt, schema=None: (live, "live-model"))
    evs, result = _ctx()
    d = ds.build_dossier(DISPUTE, evs, result, use_llm=True)
    assert (d.note_source, d.note_model) == ("ollama", "live-model")


def test_recorded_note_used_when_live_note_fails(rec: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _record_note(rec, GOOD)
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")
    evs, result = _ctx()
    assert ds.build_dossier(DISPUTE, evs, result, use_llm=True).note_source == "recorded"


@pytest.mark.usefixtures("shipped")
@pytest.mark.parametrize("s", demo.SCENARIOS, ids=lambda s: s.key)
def test_recorded_note_stays_valid_with_an_order_record_line(s: demo.Scenario) -> None:
    r = demo.resource(s)
    d = scorecard.to_dispute(
        {"reason": s.reason, "amount_value": s.value, "currency": s.currency}, scorecard.billing_of(r)
    )
    evs = [extract((SAMPLES / n).read_bytes(), use_llm=False) for n in s.docs]
    result = score(d, scorecard.merge(evs))
    plain = ds.build_dossier(d, evs, result, use_llm=False)
    line = "Order record: PayPal invoice INV2-AAAA (draft, created 2026-11-04)."
    dossier = ds.build_dossier(d, evs, result, use_llm=False, order_record=line)
    assert (dossier.note_source, dossier.note_model) == (plain.note_source, plain.note_model) == ("recorded", plain.note_model)
    assert dossier.input["evidences"][0]["notes"] == f"{plain.input['evidences'][0]['notes']} {line}"


@pytest.mark.usefixtures("shipped")
def test_score_route_keeps_the_recorded_note_after_invoice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    c = TestClient(app)
    d = c.post("/api/demo/seed").json()["disputes"][4]  # madrid
    before = c.get(f"/api/disputes/{d['id']}/score").json()
    note_before = c.get(f"/api/disputes/{d['id']}/dossier").json()
    assert c.post(f"/api/disputes/{d['id']}/paypal-invoice").status_code == 200
    after = c.get(f"/api/disputes/{d['id']}/score").json()
    note_after = c.get(f"/api/disputes/{d['id']}/dossier").json()
    assert after["factors"] == before["factors"]
    assert note_before["note_source"] == note_after["note_source"] == "recorded"
    assert note_before["note_model"] == note_after["note_model"]


def test_facts_hash_is_stable_across_runs() -> None:
    keys = set()
    for _ in range(2):
        s = demo.SCENARIOS[0]
        r = demo.resource(s)  # fresh dispute id and due date each time
        d = scorecard.to_dispute(
            {"reason": r["reason"], "amount_value": r["dispute_amount"]["value"], "currency": s.currency},
            scorecard.billing_of(r),
        )
        evs = [extract((SAMPLES / n).read_bytes(), use_llm=False) for n in s.docs]
        keys.add(recorded.facts_key(ds._facts(d, evs, score(d, scorecard.merge(evs)))))
    assert len(keys) == 1


@pytest.mark.usefixtures("shipped")
def test_seeded_cases_get_recorded_notes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "t.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    c = TestClient(app)
    got = {}
    for s, d in zip(demo.SCENARIOS, c.post("/api/demo/seed").json()["disputes"], strict=True):
        got[s.key] = c.get(f"/api/disputes/{d['id']}/dossier").json()["note_source"]
    assert got == {s.key: "recorded" for s in demo.SCENARIOS}


@pytest.mark.usefixtures("shipped")
@pytest.mark.parametrize("s", demo.SCENARIOS, ids=lambda s: s.key)
def test_every_scenario_has_a_recorded_note_that_passes_the_runtime_check(s: demo.Scenario) -> None:
    r = demo.resource(s)
    d = scorecard.to_dispute(
        {"reason": s.reason, "amount_value": s.value, "currency": s.currency}, scorecard.billing_of(r)
    )
    evs = [extract((SAMPLES / n).read_bytes(), use_llm=False) for n in s.docs]
    entry = recorded.note(ds._facts(d, evs, score(d, scorecard.merge(evs))))
    assert entry and entry["model"]
    assert ds.fact_check(entry["note"], d, evs) == [] and not ds._CONCEDES_RE.search(entry["note"])
    dossier = ds.build_dossier(d, evs, score(d, scorecard.merge(evs)), use_llm=False)
    assert (dossier.note_source, dossier.note_model) == ("recorded", entry["model"])
