"""F30: Simulate chargeback rotates through varied cases, and a note never states the wrong currency."""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import demo, scorecard
from app import dossier as ds
from app.extract import ExtractedEvidence, extract
from app.main import app
from app.scoring import INR, Dispute, score
from app.submit import SAMPLES

PIN = "X-Demo-Scenario"


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_five_clicks_give_five_different_cases(client: TestClient) -> None:
    ds_ = [client.post("/api/demo/chargeback").json() for _ in range(5)]
    assert len({(d["currency"], d["amount_value"]) for d in ds_}) == 5
    assert len({d["reason"] for d in ds_}) >= 3
    actions = {client.get(f"/api/disputes/{d['id']}/score").json()["recommendation"]["action"] for d in ds_}
    assert "fight" in actions and actions & {"offer_refund", "accept"}


def test_the_first_click_is_the_walkthrough_case_and_the_rotation_wraps(client: TestClient) -> None:
    got = [client.post("/api/demo/chargeback").json() for _ in range(6)]
    assert (got[0]["currency"], got[0]["amount_value"]) == ("USD", "49.90")
    assert (got[5]["currency"], got[5]["amount_value"]) == ("USD", "49.90")


def test_the_pin_header_picks_a_scenario(client: TestClient) -> None:
    client.post("/api/demo/chargeback")
    pinned = client.post("/api/demo/chargeback", headers={**client.headers, PIN: "leeds"}).json()
    assert (pinned["currency"], pinned["amount_value"]) == ("USD", "49.90")
    assert client.post("/api/demo/chargeback", headers={**client.headers, PIN: "nope"}).status_code == 422


# ---- the note's currency ----

NOK = Dispute(reason=INR, amount=Decimal("1299.00"), billing_address="Storgata 14, 0155 Oslo", currency="NOK")
EV = [ExtractedEvidence(order_id="B-2217", carrier="PostNord", tracking_number="00370729900123456785")]


def test_fact_check_rejects_an_amount_with_the_wrong_currency_code() -> None:
    assert ds.fact_check("We received order B-2217 for USD 1299.00. Please rule in our favour.", NOK, EV)
    assert ds.fact_check("We received order B-2217 for 1299.00 USD. Please rule in our favour.", NOK, EV)


def test_fact_check_accepts_the_disputes_own_currency() -> None:
    assert ds.fact_check("We received order B-2217 for NOK 1299.00. Please rule in our favour.", NOK, EV) == []
    assert ds.fact_check("We received order B-2217 for 1299.00 NOK. Please rule in our favour.", NOK, EV) == []


def test_a_live_note_with_the_wrong_currency_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    monkeypatch.setattr("app.llm.ollama_chat", lambda prompt, schema=None: ("We hold order B-2217 for USD 1299.00. Please rule in our favour.", "m"))
    result = score(NOK, scorecard.merge(EV))
    d = ds.build_dossier(NOK, EV, result, use_llm=True)
    assert d.note_source == "template"
    assert "USD" not in d.input["evidences"][0]["notes"]


# ---- recorded.json ----


def test_every_recorded_note_states_its_scenarios_currency() -> None:
    code = re.compile(r"\b(USD|GBP|EUR|NOK|SEK|DKK|CHF|CAD|AUD)\b")
    data = json.loads((SAMPLES / "recorded.json").read_text(encoding="utf-8"))
    by_key = {s.key: s for s in demo.SCENARIOS}
    assert set(data["notes"]) and {n["scenario"] for n in data["notes"].values()} <= set(by_key)
    for entry in data["notes"].values():
        s = by_key[entry["scenario"]]
        assert set(code.findall(entry["note"])) <= {s.currency}, (s.key, entry["note"])
        d = scorecard.to_dispute({"reason": s.reason, "amount_value": s.value, "currency": s.currency}, s.billing)
        evs = [extract((SAMPLES / n).read_bytes(), use_llm=False) for n in s.docs]
        assert ds.fact_check(entry["note"], d, evs) == []
