"""PayPal sync route, accept / offer routes and the score recommendation."""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import paypal, store
from app.main import app
from app.submit import ACCEPT_NOTE

SAMPLES = Path(__file__).parent.parent / "samples"
FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"
DID = "PP-000-042-663-135"
BASE = "https://api-m.sandbox.paypal.com"
TOKEN_URL = f"{BASE}/v1/oauth2/token"
D = f"{BASE}/v1/customer/disputes"
REAL_ID = os.environ.get("PAYPAL_CLIENT_ID", "")
REAL_SECRET = os.environ.get("PAYPAL_CLIENT_SECRET", "")
KEYS_MSG = "PayPal keys are not set: add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env"


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    for key in ("PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    paypal._token = None


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def resource(**over: Any) -> dict[str, Any]:
    e: dict[str, Any] = json.loads(FIXTURE.read_text())
    e["resource"].update(over)
    return dict(e["resource"])


def ingest(client: TestClient, **over: Any) -> str:
    e: dict[str, Any] = json.loads(FIXTURE.read_text())
    e["resource"].update(over)
    e["id"] = f"WH-{DID}-{over.get('status', '')}"
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    return DID


def actions(client: TestClient, did: str) -> list[str]:
    return [a["action"] for a in client.get(f"/api/disputes/{did}/audit").json()]


def creds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")


def mock_token(router: respx.MockRouter) -> None:
    router.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}))


def mock_list(router: respx.MockRouter, debug: str | None = "dbg-list") -> None:
    mock_token(router)
    headers = {"paypal-debug-id": debug} if debug else {}
    router.get(D).mock(return_value=httpx.Response(200, json={"items": [{"dispute_id": DID}]}, headers=headers))
    router.get(f"{D}/{DID}").mock(return_value=httpx.Response(200, json=resource()))


def paypal_dispute(client: TestClient, router: respx.MockRouter) -> str:
    mock_list(router)
    r = client.post("/api/paypal/sync")
    assert r.status_code == 200, r.text
    return DID


# ---- sync ----


def test_paypal_sync_without_keys_is_409_with_message(client: TestClient) -> None:
    r = client.post("/api/paypal/sync")
    assert r.status_code == 409
    assert r.json()["detail"] == KEYS_MSG


def test_paypal_sync_returns_summary_and_upserts(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        mock_list(router)
        r = client.post("/api/paypal/sync")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert body["debug_id"] == "dbg-list"
    assert body["mode"] == "sandbox"
    assert body["disputes"] == [{"dispute_id": DID, "result": "stored"}]
    assert datetime.fromisoformat(body["fetched_at"]).utcoffset().total_seconds() == 0  # type: ignore[union-attr]
    assert client.get("/api/disputes").json()[0]["source"] == "paypal"
    assert actions(client, DID) == ["synced"]


def test_paypal_sync_debug_id_none_without_header(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        mock_list(router, debug=None)
        body = client.post("/api/paypal/sync").json()
    assert body["debug_id"] is None


def test_paypal_sync_live_base_reports_live_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    with respx.mock() as router:
        router.post("https://api-m.paypal.com/v1/oauth2/token").mock(
            return_value=httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        )
        router.get("https://api-m.paypal.com/v1/customer/disputes").mock(return_value=httpx.Response(200, json={"items": []}))
        body = client.post("/api/paypal/sync").json()
    assert (body["mode"], body["count"], body["disputes"]) == ("live", 0, [])


def test_paypal_sync_error_is_502_with_debug_id(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        mock_token(router)
        router.get(D).mock(
            return_value=httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR", "message": "boom", "debug_id": "dbgE"})
        )
        r = client.post("/api/paypal/sync")
    assert r.status_code == 502
    assert r.json()["detail"]["debug_id"] == "dbgE"
    assert r.json()["detail"]["paypal_name"] == "INTERNAL_SERVER_ERROR"
    assert "boom" in r.json()["detail"]["message"]


def test_old_sync_path_is_an_alias(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        mock_list(router)
        r = client.post("/api/disputes/sync")
    assert r.status_code == 200
    assert r.json()["count"] == 1
    assert r.json()["debug_id"] == "dbg-list"


def test_old_sync_path_without_keys_is_409(client: TestClient) -> None:
    r = client.post("/api/disputes/sync")
    assert r.status_code == 409
    assert r.json()["detail"] == KEYS_MSG


def test_live_sandbox_paypal_sync(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    if not (REAL_ID and REAL_SECRET):
        pytest.fail("Needs fix: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", REAL_ID)
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", REAL_SECRET)
    r = client.post("/api/paypal/sync")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == len(body["disputes"])
    assert body["debug_id"]
    assert body["mode"] in ("sandbox", "live")


# ---- accept: demo ----


def test_accept_demo_is_labelled_resolved_and_audited(client: TestClient) -> None:
    did = ingest(client)
    with respx.mock(assert_all_called=False) as router:
        any_call = router.route().mock(return_value=httpx.Response(500))
        r = client.post(f"/api/disputes/{did}/accept", json={"note": "refund the buyer"})
    assert not any_call.called
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["demo"], body["action"], body["status"]) == ("demo", True, "accept", "RESOLVED")
    assert body["label"] == "Demo mode: nothing was sent to PayPal"
    assert "paypal_response" in body
    assert client.get(f"/api/disputes/{did}").json()["status"] == "RESOLVED"
    assert actions(client, did) == ["accepted"]
    assert client.get(f"/api/disputes/{did}/audit").json()[0]["detail"]["mode"] == "demo"


def test_accept_without_body_works(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/accept").status_code == 200


def test_accept_note_too_long_is_422(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/accept", json={"note": "x" * 2001}).status_code == 422
    assert actions(client, did) == []


def test_accept_unknown_is_404(client: TestClient) -> None:
    assert client.post("/api/disputes/NOPE/accept").status_code == 404


def test_accept_closed_by_status_is_409(client: TestClient) -> None:
    did = ingest(client, status="RESOLVED")
    assert client.post(f"/api/disputes/{did}/accept").status_code == 409


def test_accept_closed_by_outcome_is_409(client: TestClient) -> None:
    did = ingest(client, dispute_outcome={"outcome_code": "RESOLVED_SELLER_FAVOUR"})
    assert client.post(f"/api/disputes/{did}/accept").status_code == 409


def test_accept_twice_is_409(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/accept").status_code == 200
    assert client.post(f"/api/disputes/{did}/accept").status_code == 409


def test_accept_after_evidence_submission_is_409(client: TestClient) -> None:
    did = ingest(client)
    client.post(
        f"/api/disputes/{did}/documents",
        params={"name": "ups_receipt.pdf"},
        content=(SAMPLES / "ups_receipt.pdf").read_bytes(),
        headers={"content-type": "application/pdf"},
    )
    assert client.post(f"/api/disputes/{did}/submit").status_code == 200
    r = client.post(f"/api/disputes/{did}/accept")
    assert r.status_code == 409
    assert "submission" in r.json()["detail"] or "already" in r.json()["detail"]


# ---- offer: demo ----


def test_offer_demo_is_labelled_waiting_and_audited(client: TestClient) -> None:
    did = ingest(client)
    r = client.post(f"/api/disputes/{did}/offer", json={"amount": "1.50", "note": "partial refund"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["demo"], body["action"]) == ("demo", True, "offer")
    assert body["status"] == "WAITING_FOR_BUYER_RESPONSE"
    assert body["label"] == "Demo mode: nothing was sent to PayPal"
    assert client.get(f"/api/disputes/{did}").json()["status"] == "WAITING_FOR_BUYER_RESPONSE"
    assert actions(client, did) == ["offered"]


def test_offer_twice_is_409(client: TestClient) -> None:
    did = ingest(client)
    body = {"amount": "1.50", "note": "n"}
    assert client.post(f"/api/disputes/{did}/offer", json=body).status_code == 200
    assert client.post(f"/api/disputes/{did}/offer", json=body).status_code == 409


def test_offer_after_accept_is_409(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/accept").status_code == 200
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 409


def test_offer_closed_is_409(client: TestClient) -> None:
    did = ingest(client, status="RESOLVED")
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 409


def test_offer_unknown_is_404(client: TestClient) -> None:
    assert client.post("/api/disputes/NOPE/offer", json={"amount": "1", "note": "n"}).status_code == 404


@pytest.mark.parametrize("amount", ["0", "-2", "abc", "NaN", "1e3", "", "1.234567890123456789012345678901"])
def test_offer_bad_amount_is_422_and_leaves_no_claim(client: TestClient, amount: str) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": amount, "note": "n"}).status_code == 422
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 200


def test_offer_above_disputed_amount_is_422(client: TestClient) -> None:
    did = ingest(client)  # fixture dispute is 3.00 USD
    r = client.post(f"/api/disputes/{did}/offer", json={"amount": "3.01", "note": "n"})
    assert r.status_code == 422
    assert "offer can't be more than the disputed 3.00 USD" in r.json()["detail"]
    assert actions(client, did) == []
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "3.00", "note": "n"}).status_code == 200


def test_offer_equal_to_disputed_amount_is_allowed_however_written(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "3", "note": "n"}).status_code == 200


@pytest.mark.parametrize("payload", [{"amount": "1"},{"note": "n"}, {"amount": "1", "note": ""}, {"amount": "1", "note": "x" * 2001}, {}])
def test_offer_bad_body_is_422(client: TestClient, payload: dict[str, Any]) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/offer", json=payload).status_code == 422


# ---- accept / offer: paypal ----


def test_accept_paypal_calls_live_then_refreshes_status(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        route = router.post(f"{D}/{did}/accept-claim").mock(return_value=httpx.Response(200, json={"links": []}))
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=resource(status="RESOLVED")))
        r = client.post(f"/api/disputes/{did}/accept", json={"note": "refund"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["demo"], body["action"], body["status"]) == ("paypal", False, "accept", "RESOLVED")
    assert "PayPal sandbox" in body["label"]
    assert body["paypal_response"] == {"links": []}
    assert json.loads(route.calls.last.request.content) == {"note": "refund", "accept_claim_type": "REFUND"}
    assert client.get(f"/api/disputes/{did}").json()["status"] == "RESOLVED"
    assert actions(client, did)[-1] == "accepted"


def test_offer_paypal_sends_amount_in_dispute_currency(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        route = router.post(f"{D}/{did}/make-offer").mock(return_value=httpx.Response(200, json={}))
        router.get(f"{D}/{did}").mock(
            return_value=httpx.Response(200, json=resource(status="WAITING_FOR_BUYER_RESPONSE"))
        )
        r = client.post(f"/api/disputes/{did}/offer", json={"amount": "1.50", "note": "half"})
    assert r.status_code == 200, r.text
    assert json.loads(route.calls.last.request.content) == {
        "note": "half",
        "offer_amount": {"currency_code": "USD", "value": "1.50"},
        "offer_type": "REFUND",
    }
    assert r.json()["mode"] == "paypal"
    assert actions(client, did)[-1] == "offered"


def test_accept_paypal_tolerates_status_refresh_failure(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        router.post(f"{D}/{did}/accept-claim").mock(return_value=httpx.Response(200, json={}))
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(500, json={"name": "X"}))
        r = client.post(f"/api/disputes/{did}/accept")
    assert r.status_code == 200
    assert r.json()["status"] == "RESOLVED"


def test_accept_paypal_error_is_502_audited_and_releases_claim(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    err = {"name": "ACTION_NOT_ALLOWED", "message": "nope", "debug_id": "dbgX"}
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        router.post(f"{D}/{did}/accept-claim").mock(
            side_effect=[httpx.Response(422, json=err), httpx.Response(200, json={})]
        )
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=resource(status="RESOLVED")))
        first = client.post(f"/api/disputes/{did}/accept")
        assert first.status_code == 502
        detail = first.json()["detail"]
        assert (detail["debug_id"], detail["paypal_name"]) == ("dbgX", "ACTION_NOT_ALLOWED")
        assert actions(client, did)[-1] == "accept_failed"
        assert client.get(f"/api/disputes/{did}/audit").json()[-1]["detail"]["debug_id"] == "dbgX"
        assert client.post(f"/api/disputes/{did}/accept").status_code == 200


def test_offer_paypal_error_is_502_audited(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    err = {"name": "INVALID_REQUEST", "message": "bad", "debug_id": "dbgY"}
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        router.post(f"{D}/{did}/make-offer").mock(return_value=httpx.Response(400, json=err))
        r = client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"})
    assert r.status_code == 502
    assert r.json()["detail"]["debug_id"] == "dbgY"
    assert actions(client, did)[-1] == "offer_failed"


def test_paypal_source_without_keys_is_409_and_claims_nothing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
    monkeypatch.delenv("PAYPAL_CLIENT_ID")
    for path, body in (("accept", None), ("offer", {"amount": "1", "note": "n"})):
        r = client.post(f"/api/disputes/{did}/{path}", json=body)
        assert r.status_code == 409
        assert r.json()["detail"] == KEYS_MSG
    assert actions(client, did) == ["synced"]
    assert client.get(f"/api/disputes/{did}").json()["status"] == "OPEN"
    assert not store.has_live_submission(did)


# ---- review fixes ----


def flag(did: str) -> None:
    store.add_audit(did, "autopilot_flagged", {"reasons": ["needs a look"]})


def review_reasons(client: TestClient, did: str) -> Any:
    return next(x for x in client.get("/api/disputes").json() if x["id"] == did)["review_reasons"]


@pytest.mark.parametrize("path,body", [("accept", None), ("offer", {"amount": "1", "note": "n"})])
def test_accept_and_offer_clear_the_review_flag(client: TestClient, path: str, body: dict[str, str] | None) -> None:
    did = ingest(client)
    flag(did)
    assert review_reasons(client, did) == ["needs a look"]
    assert client.post(f"/api/disputes/{did}/{path}", json=body).status_code == 200
    assert review_reasons(client, did) is None


def test_accept_note_is_stripped_and_blank_falls_back(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/accept", json={"note": "   "}).status_code == 200
    assert client.get(f"/api/disputes/{did}/audit").json()[-1]["detail"]["note"] == ACCEPT_NOTE
    did2 = "PP-OTHER-1"
    e: dict[str, Any] = json.loads(FIXTURE.read_text())
    e["resource"]["dispute_id"] = did2
    e["id"] = "WH-other"
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    assert client.post(f"/api/disputes/{did2}/accept", json={"note": "  hi there \n"}).status_code == 200
    assert client.get(f"/api/disputes/{did2}/audit").json()[-1]["detail"]["note"] == "hi there"


def test_offer_blank_note_is_422_without_claim_or_audit(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "  \n "}).status_code == 422
    assert actions(client, did) == []
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "ok"}).status_code == 200


def timeout_dispute(client: TestClient, monkeypatch: pytest.MonkeyPatch, router: respx.MockRouter, suffix: str) -> str:
    creds(monkeypatch)
    did = paypal_dispute(client, router)
    router.post(f"{D}/{did}/{suffix}").mock(side_effect=httpx.ReadTimeout("slow"))
    return did


def test_timeout_then_changed_status_is_reconciled_as_done(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    with respx.mock() as router:
        did = timeout_dispute(client, monkeypatch, router, "accept-claim")
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=resource(status="RESOLVED")))
        r = client.post(f"/api/disputes/{did}/accept")
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["mode"]) == ("RESOLVED", "paypal")
    assert client.get(f"/api/disputes/{did}").json()["status"] == "RESOLVED"
    last = client.get(f"/api/disputes/{did}/audit").json()[-1]
    assert (last["action"], last["detail"]["reconciled"]) == ("accepted", True)
    assert client.post(f"/api/disputes/{did}/accept").status_code == 409


def test_timeout_then_same_status_releases_claim_and_is_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    with respx.mock() as router:
        did = timeout_dispute(client, monkeypatch, router, "make-offer")
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=resource()))
        r = client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"})
        assert r.status_code == 502
        assert actions(client, did)[-1] == "offer_failed"
        router.post(f"{D}/{did}/make-offer").mock(return_value=httpx.Response(200, json={}))
        assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 200


def test_timeout_and_refresh_failure_keeps_claim_and_says_to_sync(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    with respx.mock() as router:
        did = timeout_dispute(client, monkeypatch, router, "accept-claim")
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(500, json={"name": "X"}))
        r = client.post(f"/api/disputes/{did}/accept")
        assert r.status_code == 502
        assert "Sync from PayPal" in r.json()["detail"]["message"]
        assert actions(client, did)[-1] == "accept_unconfirmed"
        again = client.post(f"/api/disputes/{did}/accept")
    assert again.status_code == 409


def test_definite_failure_is_not_reconciled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        router.post(f"{D}/{did}/accept-claim").mock(return_value=httpx.Response(400, json={"name": "BAD"}))
        show = router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=resource(status="RESOLVED")))
        shown_before = show.call_count
        assert client.post(f"/api/disputes/{did}/accept").status_code == 502
        assert show.call_count == shown_before
    assert client.get(f"/api/disputes/{did}").json()["status"] == "OPEN"


def test_refresh_failure_is_marked_unverified(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    creds(monkeypatch)
    with respx.mock() as router:
        did = paypal_dispute(client, router)
        router.post(f"{D}/{did}/accept-claim").mock(return_value=httpx.Response(200, json={}))
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(500, json={"name": "X"}))
        assert client.post(f"/api/disputes/{did}/accept").status_code == 200
    assert client.get(f"/api/disputes/{did}/audit").json()[-1]["detail"]["status_verified"] is False


def test_offer_leaves_room_to_accept_or_send_evidence_later(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 200
    assert not store.has_live_submission(did)
    assert client.post(f"/api/disputes/{did}/accept").status_code == 200


def test_offer_then_evidence_is_allowed(client: TestClient) -> None:
    did = ingest(client)
    client.post(
        f"/api/disputes/{did}/documents",
        params={"name": "ups_receipt.pdf"},
        content=(SAMPLES / "ups_receipt.pdf").read_bytes(),
        headers={"content-type": "application/pdf"},
    )
    assert client.post(f"/api/disputes/{did}/offer", json={"amount": "1", "note": "n"}).status_code == 200
    assert client.post(f"/api/disputes/{did}/submit").status_code == 200


def test_second_offer_is_409_while_waiting_and_after_status_moves_on(client: TestClient) -> None:
    did = ingest(client)
    body = {"amount": "1", "note": "n"}
    assert client.post(f"/api/disputes/{did}/offer", json=body).status_code == 200
    assert client.post(f"/api/disputes/{did}/offer", json=body).status_code == 409  # status waits for the buyer
    store.set_status(did, "WAITING_FOR_SELLER_RESPONSE")
    assert client.post(f"/api/disputes/{did}/offer", json=body).status_code == 409  # offered, not superseded


def test_autopilot_does_not_send_evidence_while_waiting_for_buyer(client: TestClient) -> None:
    store.set_autopilot(True, 0)
    did = ingest(client, status="WAITING_FOR_BUYER_RESPONSE")
    r = client.post(
        f"/api/disputes/{did}/documents",
        params={"name": "ups_receipt.pdf"},
        content=(SAMPLES / "ups_receipt.pdf").read_bytes(),
        headers={"content-type": "application/pdf"},
    )
    assert r.status_code == 200
    acts = actions(client, did)
    assert "autopilot_skipped" in acts
    assert "submitted" not in acts


# ---- recommendation ----


def test_score_route_includes_recommendation(client: TestClient) -> None:
    did = ingest(client)
    r = client.get(f"/api/disputes/{did}/score")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "probability" in body and "factors" in body and "dossier" in body
    rec = body["recommendation"]
    assert set(rec) == {"action", "reason", "fight_at", "accept_below"}
    assert (rec["fight_at"], rec["accept_below"]) == (60, 30)
    assert rec["action"] in ("fight", "offer_refund", "accept")
    assert str(body["probability"]) in rec["reason"]
