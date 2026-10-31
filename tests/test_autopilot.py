"""F9: the autopilot agent. Given/When/Then acceptance tests; nothing here calls the submit route to get a dispute sent."""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import autopilot, paypal, submit
from app.main import app

SAMPLES = Path(__file__).parent.parent / "samples"
FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"
STEPS = ["autopilot_started", "autopilot_evidence", "autopilot_scored"]


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    for key in ("PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def configure(client: TestClient, enabled: bool, threshold: int = 85) -> None:
    assert client.put("/api/autopilot", json={"enabled": enabled, "threshold": threshold}).status_code == 200


def simulate(client: TestClient) -> str:
    r = client.post("/api/demo/chargeback")
    assert r.status_code == 200, r.text
    return str(r.json()["id"])


def audit(client: TestClient, did: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = client.get(f"/api/disputes/{did}/audit").json()
    return out


def actions(client: TestClient, did: str) -> list[str]:
    return [a["action"] for a in audit(client, did)]


def row(client: TestClient, did: str) -> dict[str, Any]:
    return next(r for r in client.get("/api/disputes").json() if r["id"] == did)


def created_event() -> dict[str, Any]:
    e: dict[str, Any] = json.loads(FIXTURE.read_text())
    assert e["event_type"] == "CUSTOMER.DISPUTE.CREATED"
    return e


# ---- settings ----


def test_settings_default_to_off_and_85(client: TestClient) -> None:
    """Given a fresh database, when the settings are read, then autopilot is off and the threshold is 85."""
    assert client.get("/api/autopilot").json() == {"enabled": False, "threshold": 85}


def test_settings_round_trip(client: TestClient) -> None:
    """Given valid settings, when they are saved, then a later read returns them."""
    r = client.put("/api/autopilot", json={"enabled": True, "threshold": 0})
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "threshold": 0}
    assert client.get("/api/autopilot").json() == {"enabled": True, "threshold": 0}
    configure(client, True, 100)
    assert client.get("/api/autopilot").json() == {"enabled": True, "threshold": 100}


@pytest.mark.parametrize(
    "body",
    [
        {"enabled": True, "threshold": 101},
        {"enabled": True, "threshold": -1},
        {"enabled": True, "threshold": "high"},
        {"enabled": True, "threshold": 50.5},
        {"enabled": True, "threshold": None},
        {"enabled": "maybe", "threshold": 50},
        {"enabled": True},
        {},
    ],
)
def test_bad_settings_are_422_and_not_saved(client: TestClient, body: dict[str, Any]) -> None:
    """Given a bad body, when it is saved, then the answer is 422 and the settings are unchanged."""
    assert client.put("/api/autopilot", json=body).status_code == 422
    assert client.get("/api/autopilot").json() == {"enabled": False, "threshold": 85}


# ---- the agent ----


def test_autopilot_on_submits_the_demo_chargeback(client: TestClient) -> None:
    """Given autopilot on, when a chargeback arrives, then it ends submitted with every step in the audit log."""
    configure(client, True)
    did = simulate(client)
    d = client.get(f"/api/disputes/{did}").json()
    assert d["status"] == "UNDER_REVIEW"
    acts = actions(client, did)
    assert acts[:2] == ["simulated_chargeback", "document_added"]
    assert [a for a in acts if a.startswith("autopilot_")] == [*STEPS, "autopilot_submitted"]
    log = {a["action"]: a["detail"] for a in audit(client, did)}
    assert log["autopilot_evidence"]["documents"] == 1
    assert "tracking_number" in log["autopilot_evidence"]["fields"]
    assert log["autopilot_scored"] == {"probability": 100, "threshold": 85}
    assert row(client, did)["review_reasons"] is None
    # a submission row exists: a second claim is refused
    assert client.post(f"/api/disputes/{did}/submit").status_code == 409


def test_autopilot_off_flags_for_review(client: TestClient) -> None:
    """Given autopilot off, when a chargeback arrives, then it is flagged "Waiting for you to review: autopilot is off" and not sent."""
    did = simulate(client)
    assert client.get(f"/api/disputes/{did}").json()["status"] == "OPEN"
    flagged = [a for a in audit(client, did) if a["action"] == "autopilot_flagged"]
    assert [f["detail"]["reasons"] for f in flagged] == [["Waiting for you to review: autopilot is off"]]
    assert "autopilot_submitted" not in actions(client, did)
    assert row(client, did)["review_reasons"] == ["Waiting for you to review: autopilot is off"]


def test_below_threshold_flags_with_unmet_factors(client: TestClient) -> None:
    """Given threshold 100 and a case below it, when its evidence arrives, then it is flagged with the gap and each unmet factor."""
    configure(client, True, 100)
    e = created_event()
    did = e["resource"]["dispute_id"]
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    body = (SAMPLES / "ups_receipt.pdf").read_bytes()
    assert client.post(f"/api/disputes/{did}/documents", params={"name": "ups_receipt.pdf"}, content=body).status_code == 200
    assert client.get(f"/api/disputes/{did}").json()["status"] == "OPEN"
    s = client.get(f"/api/disputes/{did}/score").json()
    assert s["probability"] < 100
    unmet = [f["label"] for f in s["factors"] if not f["met"]]
    reasons = row(client, did)["review_reasons"]
    assert reasons == [f"Win probability {s['probability']}% is below the 100% threshold", *unmet]
    assert "autopilot_submitted" not in actions(client, did)


def test_webhook_without_documents_is_flagged_then_submitted_when_evidence_arrives(client: TestClient) -> None:
    """Given autopilot on and a webhook with no documents, when it lands, then it is flagged; when a receipt is
    uploaded, then autopilot runs again and submits."""
    configure(client, True, 0)
    e = created_event()
    did = e["resource"]["dispute_id"]
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    assert row(client, did)["review_reasons"] == ["No evidence documents"]
    assert client.get(f"/api/disputes/{did}").json()["status"] != "UNDER_REVIEW"

    body = (SAMPLES / "ups_receipt.pdf").read_bytes()
    r = client.post(f"/api/disputes/{did}/documents", params={"name": "ups_receipt.pdf"}, content=body)
    assert r.status_code == 200, r.text
    assert client.get(f"/api/disputes/{did}").json()["status"] == "UNDER_REVIEW"
    assert row(client, did)["review_reasons"] is None
    assert "autopilot_submitted" in actions(client, did)


def test_duplicate_webhook_does_not_run_twice(client: TestClient) -> None:
    """Given autopilot on, when the same CREATED event is delivered twice, then the agent ran once."""
    configure(client, True)
    e = created_event()
    did = e["resource"]["dispute_id"]
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    assert client.post("/api/webhooks/paypal", json=e).json() == {"duplicate": True}
    assert actions(client, did).count("autopilot_started") == 1


def test_submit_failure_is_flagged_not_raised(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Given PayPal rejects the evidence, when autopilot submits, then it flags the error and nothing escapes."""

    def boom(*_a: Any, **_k: Any) -> Any:
        raise paypal.PayPalError("PayPal said no")

    monkeypatch.setattr(submit, "build_dossier", boom)
    configure(client, True)
    did = simulate(client)  # a raised exception would surface here as a 500
    assert row(client, did)["review_reasons"] == ["PayPal said no"]
    assert client.get(f"/api/disputes/{did}").json()["status"] == "OPEN"
    assert "autopilot_submitted" not in actions(client, did)


def test_already_submitted_is_skipped(client: TestClient) -> None:
    """Given a dispute that was submitted by hand, when autopilot runs on it, then it only records a skip."""
    did = simulate(client)
    assert client.post(f"/api/disputes/{did}/submit").status_code == 200
    before = len(audit(client, did))
    configure(client, True)
    asyncio.run(autopilot.run(did))
    assert actions(client, did)[before:] == ["autopilot_skipped"]
    assert row(client, did)["review_reasons"] is None


def test_unknown_dispute_never_raises() -> None:
    """Given an id that does not exist, when autopilot runs, then it returns quietly."""
    asyncio.run(autopilot.run("NOPE"))
