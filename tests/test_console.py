"""F8: the score/preview endpoint and the demo chargeback endpoint behind the console."""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import submit
from app.dossier import build_dossier
from app.main import app

SAMPLES = Path(__file__).parent.parent / "samples"
FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    for key in ("PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def simulate(client: TestClient) -> dict[str, Any]:
    r = client.post("/api/demo/chargeback")
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def bare_dispute(client: TestClient) -> str:
    e = json.loads(FIXTURE.read_text())
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    return str(e["resource"]["dispute_id"])


def test_demo_chargeback_creates_dispute_with_receipt(client: TestClient) -> None:
    d = simulate(client)
    assert d["source"] == "simulated"
    assert d["reason"] == "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
    assert d["status"] == "OPEN"
    assert d["seller_response_due_date"]
    docs = client.get(f"/api/disputes/{d['id']}/documents").json()
    assert [x["name"] for x in docs] == ["ups_receipt.pdf"]
    assert docs[0]["evidence"]["tracking_number"] == "1Z999AA10123456784"
    actions = [a["action"] for a in client.get(f"/api/disputes/{d['id']}/audit").json()]
    assert actions[:2] == ["simulated_chargeback", "document_added"]  # autopilot (off) then flags it, see test_autopilot


def test_config_reports_demo_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get("/api/config").json() == {"demo_mode": True}
    monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE")
    assert client.get("/api/config").json() == {"demo_mode": False}


def test_demo_chargeback_ids_are_distinct(client: TestClient) -> None:
    ids = {simulate(client)["id"] for _ in range(3)}
    assert len(ids) == 3
    assert len(client.get("/api/disputes").json()) == 3


def test_demo_chargeback_needs_demo_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE")
    assert client.post("/api/demo/chargeback").status_code == 404
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "0")
    assert client.post("/api/demo/chargeback").status_code == 404
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    assert client.get("/api/disputes").json() == []


def test_score_for_demo_dispute_is_94(client: TestClient) -> None:
    did = simulate(client)["id"]
    r = client.get(f"/api/disputes/{did}/score")
    assert r.status_code == 200
    s = r.json()
    assert s["probability"] == 94
    assert sum(f["points"] for f in s["factors"]) + s["base"] == 94
    by_label = {f["label"]: f for f in s["factors"]}
    assert by_label["Delivered to the billing address"]["met"] is True
    assert by_label["Delivered to the billing address"]["points"] == 25
    assert by_label["Order ID on file"]["met"] is False
    assert by_label["Order ID on file"]["points"] == 0
    assert all(f["reason"] for f in s["factors"])
    assert [x["name"] for x in s["documents"]] == ["ups_receipt.pdf"]
    assert s["documents"][0]["evidence"]["source"] == "fallback"
    d = s["dossier"]
    assert d["note_source"] == "template"
    assert "1Z999AA10123456784" in d["note"]
    assert d["files"] == ["ups_receipt.pdf"]


def test_score_unknown_dispute_is_404(client: TestClient) -> None:
    assert client.get("/api/disputes/nope/score").status_code == 404


def test_score_without_documents(client: TestClient) -> None:
    did = bare_dispute(client)
    s = client.get(f"/api/disputes/{did}/score").json()
    assert s["probability"] == 9
    assert s["documents"] == []
    assert s["dossier"]["files"] == []
    assert s["dossier"]["note"]


def test_list_has_win_probability(client: TestClient) -> None:
    bare = bare_dispute(client)
    did = simulate(client)["id"]
    rows = {r["id"]: r for r in client.get("/api/disputes").json()}
    assert rows[did]["win_probability"] == 94
    assert rows[bare]["win_probability"] is None
    assert "billing_address" not in rows[did]


def test_preview_is_cached_per_document_set(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []
    real = build_dossier

    def counting(*a: Any, **k: Any) -> Any:
        calls.append(1)
        return real(*a, **k)

    monkeypatch.setattr(submit, "build_dossier", counting)
    did = simulate(client)["id"]
    first = client.get(f"/api/disputes/{did}/score").json()
    assert client.get(f"/api/disputes/{did}/score").json() == first
    assert len(calls) == 1
    crm = (SAMPLES / "crm_order.pdf").read_bytes()
    r = client.post(f"/api/disputes/{did}/documents", params={"name": "crm_order.pdf"}, content=crm)
    assert r.status_code == 200
    s = client.get(f"/api/disputes/{did}/score").json()
    assert len(calls) == 2
    assert s["probability"] == 100


def test_submit_after_demo_chargeback(client: TestClient) -> None:
    did = simulate(client)["id"]
    r = client.post(f"/api/disputes/{did}/submit")
    assert r.status_code == 200
    assert r.json()["probability"] == 94
    assert r.json()["status"] == "UNDER_REVIEW"
    row = {x["id"]: x for x in client.get("/api/disputes").json()}[did]
    assert row["status"] == "UNDER_REVIEW"
