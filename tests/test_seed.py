from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import demo, scorecard
from app.extract import extract
from app.main import app
from app.scoring import INR, SNAD, UNAUTHORISED, Dispute, score
from app.submit import SAMPLES

EXPECTED = {"leeds": 94, "lisbon": 79, "oslo": 55, "bristol": 44, "madrid": 25}


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _score(s: demo.Scenario) -> int:
    r = demo.resource(s)
    evs = [extract((SAMPLES / name).read_bytes(), use_llm=False) for name in s.docs]
    dispute = Dispute(reason=r["reason"], amount=r["dispute_amount"]["value"], billing_address=scorecard.billing_of(r))
    return score(dispute, scorecard.merge(evs)).probability


def test_each_scenario_scores_what_the_rules_give() -> None:
    assert {s.key: _score(s) for s in demo.SCENARIOS} == EXPECTED


def test_first_scenario_is_the_walkthrough_case() -> None:
    s = demo.SCENARIOS[0]
    r = demo.resource(s)
    assert s.docs == ("ups_receipt.pdf",)
    assert r["reason"] == INR
    assert r["dispute_amount"] == {"currency_code": "USD", "value": "49.90"}
    assert scorecard.billing_of(r) == "12 High Street, Leeds LS1 4AB"


def test_scenarios_vary() -> None:
    assert {s.reason for s in demo.SCENARIOS} >= {INR, SNAD, UNAUTHORISED}
    assert len({s.currency for s in demo.SCENARIOS}) >= 3
    assert len({(s.currency, s.value) for s in demo.SCENARIOS}) == 5
    assert len({s.billing for s in demo.SCENARIOS}) == 5


def test_low_scenario_billing_differs_from_receipt_delivered_to() -> None:
    s = next(s for s in demo.SCENARIOS if s.key == "bristol")
    assert s.reason == INR
    delivered_to = extract((SAMPLES / s.docs[0]).read_bytes(), use_llm=False).delivered_to
    assert delivered_to
    assert delivered_to != s.billing


def test_seed_creates_five_varied_disputes(client: TestClient) -> None:
    r = client.post("/api/demo/seed")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 5
    ds = body["disputes"]
    assert len(ds) == 5
    assert len({d["id"] for d in ds}) == 5
    assert len({d["reason"] for d in ds}) >= 3
    assert len({d["currency"] for d in ds}) >= 2
    now = datetime.now(UTC)
    hours = [(datetime.fromisoformat(d["seller_response_due_date"]) - now).total_seconds() / 3600 for d in ds]
    assert any(0 < h < 48 for h in hours)
    by_key = dict(zip((s.key for s in demo.SCENARIOS), ds, strict=True))
    for s in demo.SCENARIOS:
        assert scorecard.billing_of(by_key[s.key]["resource"]) == s.billing
    rows = {d["id"]: d for d in client.get("/api/disputes").json()}
    probs = {k: rows[d["id"]]["win_probability"] for k, d in by_key.items()}
    assert probs == EXPECTED
    assert any(p < 60 for p in probs.values())
    assert len(client.get(f"/api/disputes/{by_key['oslo']['id']}/documents").json()) == 2


def test_seed_twice_gives_fresh_ids(client: TestClient) -> None:
    a = {d["id"] for d in client.post("/api/demo/seed").json()["disputes"]}
    b = {d["id"] for d in client.post("/api/demo/seed").json()["disputes"]}
    assert not a & b


def test_seed_is_404_outside_demo_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE")
    assert client.post("/api/demo/seed").status_code == 404
    assert client.get("/api/disputes").json() == []


def test_summary_needs_the_token() -> None:
    assert TestClient(app, headers={}).get("/api/summary").status_code == 401


def test_summary_empty(client: TestClient) -> None:
    assert client.get("/api/summary").json() == {"open_count": 0, "at_risk": [], "avg_win": None, "next_deadline": None}


def test_summary_seeded(client: TestClient) -> None:
    ds = client.post("/api/demo/seed").json()["disputes"]
    s: dict[str, Any] = client.get("/api/summary").json()
    assert s["open_count"] == 5
    totals: dict[str, Decimal] = {}
    for d in ds:
        totals[d["currency"]] = totals.get(d["currency"], Decimal(0)) + Decimal(d["amount_value"])
    assert s["at_risk"] == [{"currency": c, "value": f"{totals[c]:.2f}"} for c in sorted(totals)]
    assert s["avg_win"] == round(sum(EXPECTED.values()) / 5)
    soonest = min(ds, key=lambda d: d["seller_response_due_date"])
    assert s["next_deadline"]["dispute_id"] == soonest["id"]
    assert s["next_deadline"]["due"] == soonest["seller_response_due_date"]
    assert 0 < s["next_deadline"]["hours_left"] < 48


def test_summary_leaves_out_closed_disputes(client: TestClient) -> None:
    ds = client.post("/api/demo/seed").json()["disputes"]
    by_key = dict(zip((s.key for s in demo.SCENARIOS), ds, strict=True))
    assert client.post(f"/api/disputes/{by_key['madrid']['id']}/accept").status_code == 200
    assert client.post(f"/api/disputes/{by_key['leeds']['id']}/submit").status_code == 200
    s = client.get("/api/summary").json()
    assert s["open_count"] == 3
    assert s["avg_win"] == round((79 + 55 + 44) / 3)


def test_summary_counts_open_dispute_without_documents(client: TestClient) -> None:
    client.post("/api/webhooks/paypal", json=__import__("json").loads((Path(__file__).parent / "fixtures" / "dispute_created.json").read_text()))
    s = client.get("/api/summary").json()
    assert s["open_count"] == 1
    assert s["avg_win"] is None
