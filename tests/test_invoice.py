"""Second PayPal API family: the Invoicing API records the order as an invoice (client, route, live sandbox)."""

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import paypal, store
from app.main import app
from app.paypal import PayPalError
from app.submit import DEMO_LABEL, NO_KEYS
from app.webhooks import DisputeResource, dispute_row

BASE = "https://api-m.sandbox.paypal.com"
TOKEN_URL = f"{BASE}/v1/oauth2/token"
INV = f"{BASE}/v2/invoicing/invoices"
REAL_ID = os.environ.get("PAYPAL_CLIENT_ID", "")  # from .env via conftest, before any monkeypatch
REAL_SECRET = os.environ.get("PAYPAL_CLIENT_SECRET", "")
AMT = {"currency_code": "USD", "value": "49.90"}
INVOICE_BODY: dict[str, Any] = {
    "id": "INV2-AAAA-BBBB-CCCC-DDDD",
    "status": "DRAFT",
    "detail": {"invoice_number": "0042", "currency_code": "USD", "invoice_date": "2026-11-03"},
    "amount": {"currency_code": "USD", "value": "49.90"},
    "items": [{"name": "Order A-1", "quantity": "1", "unit_amount": AMT}],
    "primary_recipients": [{"billing_info": {"name": {"full_name": "Jo Smith"}}}],
}


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "inv.db"))
    for key in ("PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")  # fake keys; tests that need none delete them
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")
    paypal._token = None


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def fake_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")


def real_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    if not (REAL_ID and REAL_SECRET):
        pytest.fail("Needs fix: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", REAL_ID)
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", REAL_SECRET)


def token_ok(router: respx.MockRouter) -> None:
    router.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}))


def mock_invoice(router: respx.MockRouter, create_debug: str = "dbg-create", get_debug: str = "dbg-get") -> tuple[Any, Any]:
    token_ok(router)
    href = f"{INV}/{INVOICE_BODY['id']}"
    create = router.post(INV).mock(
        return_value=httpx.Response(
            201, json={"rel": "self", "href": href, "method": "GET"}, headers={"paypal-debug-id": create_debug}
        )
    )
    get = router.get(href).mock(return_value=httpx.Response(200, json=INVOICE_BODY, headers={"paypal-debug-id": get_debug}))
    return create, get


def seed_demo(client: TestClient) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = client.post("/api/demo/seed").json()["disputes"]
    return out


def paypal_row(dispute_id: str = "PP-D-INV-1") -> str:
    """A dispute that came from PayPal (source 'paypal'), reason INR, USD 49.90."""
    resource = {
        "dispute_id": dispute_id,
        "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        "status": "OPEN",
        "dispute_amount": AMT,
        "create_time": "2026-11-01T10:00:00.000Z",
        "update_time": "2026-11-01T10:00:00.000Z",
        "buyer": {"name": "Jo Smith"},
    }
    store.upsert_dispute(dispute_row(DisputeResource.model_validate(resource), resource, "paypal"))
    return dispute_id


def actions(client: TestClient, did: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = client.get(f"/api/disputes/{did}/audit").json()
    return out


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---- client ----


def test_create_invoice_posts_draft_and_returns_id_and_debug_id() -> None:
    with respx.mock(assert_all_called=False) as router:
        create, _ = mock_invoice(router)
        invoice_id, debug_id = run(paypal.create_invoice("Order A-1", AMT, recipient_name="Jo Smith", note="Order A-1"))
    assert invoice_id == INVOICE_BODY["id"]
    assert debug_id == "dbg-create"
    req = create.calls.last.request
    assert req.headers["authorization"] == "Bearer tok"
    body = json.loads(req.content)
    assert body["detail"]["currency_code"] == "USD"
    assert body["items"] == [{"name": "Order A-1", "quantity": "1", "unit_amount": AMT}]
    assert body["primary_recipients"][0]["billing_info"]["name"]["full_name"] == "Jo Smith"


def test_create_invoice_without_recipient_sends_none() -> None:
    with respx.mock(assert_all_called=False) as router:
        create, _ = mock_invoice(router)
        run(paypal.create_invoice("Order A-1", AMT))
    assert "primary_recipients" not in json.loads(create.calls.last.request.content)


def test_get_invoice_returns_body_and_debug_id() -> None:
    with respx.mock(assert_all_called=False) as router:
        _, get = mock_invoice(router)
        body, debug_id = run(paypal.get_invoice(INVOICE_BODY["id"]))
    assert body["status"] == "DRAFT"
    assert debug_id == "dbg-get"
    assert get.called


def test_create_invoice_refuses_non_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.create_invoice("x", AMT))
        assert len(router.calls) == 0


@pytest.mark.parametrize("bad", ["", "../x", "INV2/../../y", "a b", "INV2?x=1", "é"])
def test_get_invoice_rejects_bad_ids_without_http(bad: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="invoice id"):
            run(paypal.get_invoice(bad))
        assert len(router.calls) == 0


@pytest.mark.parametrize("name", ["", "   ", "x" * 201])
def test_create_invoice_rejects_bad_item_name(name: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="name"):
            run(paypal.create_invoice(name, AMT))
        assert len(router.calls) == 0


def test_create_invoice_rejects_bad_amount() -> None:
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="amount"):
            run(paypal.create_invoice("x", {"currency_code": "USD", "value": "-1"}))
        assert len(router.calls) == 0


def test_create_invoice_with_unusable_link_is_an_error() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.post(INV).mock(return_value=httpx.Response(201, json={"href": ""}, headers={"paypal-debug-id": "d1"}))
        with pytest.raises(PayPalError, match="invoice id") as ei:
            run(paypal.create_invoice("x", AMT))
    assert ei.value.debug_id == "d1"


def test_invoice_error_carries_debug_id() -> None:
    err = {"name": "INVALID_REQUEST", "message": "bad", "debug_id": "dbgI"}
    with respx.mock() as router:
        token_ok(router)
        router.post(INV).mock(return_value=httpx.Response(400, json=err))
        with pytest.raises(PayPalError) as ei:
            run(paypal.create_invoice("x", AMT))
    assert (ei.value.status, ei.value.name, ei.value.debug_id) == (400, "INVALID_REQUEST", "dbgI")


def test_record_invoice_summarises_fields() -> None:
    with respx.mock() as router:
        mock_invoice(router)
        rec = run(paypal.record_invoice("Order A-1", AMT, recipient_name="Jo Smith"))
    assert rec["invoice_id"] == INVOICE_BODY["id"]
    assert rec["invoice_number"] == "0042"
    assert rec["status"] == "DRAFT"
    assert rec["total"] == AMT
    assert rec["item"] == "Order A-1"
    assert rec["recipient"] == "Jo Smith"
    assert rec["debug_id"] == "dbg-create"
    assert rec["lookup_debug_id"] == "dbg-get"


def test_record_invoice_keeps_going_when_lookup_fails() -> None:
    with respx.mock() as router:
        token_ok(router)
        href = f"{INV}/{INVOICE_BODY['id']}"
        router.post(INV).mock(return_value=httpx.Response(201, json={"href": href}, headers={"paypal-debug-id": "dbg-c"}))
        router.get(href).mock(return_value=httpx.Response(500, json={"debug_id": "dbg-x"}))
        rec = run(paypal.record_invoice("Order A-1", AMT))
    assert rec["invoice_id"] == INVOICE_BODY["id"]
    assert rec["status"] == "DRAFT"  # a fresh invoice is a draft
    assert rec["verified"] is False
    assert rec["debug_id"] == "dbg-c"


# ---- route: demo ----


def test_route_needs_the_operator_token() -> None:
    bare = TestClient(app, headers={})
    assert bare.post("/api/disputes/x/paypal-invoice").status_code == 401


def test_route_unknown_dispute_404(client: TestClient) -> None:
    assert client.post("/api/disputes/nope/paypal-invoice").status_code == 404


def test_demo_dispute_gets_a_labelled_fixture_and_no_http(client: TestClient) -> None:
    d = seed_demo(client)[1]  # lisbon, 79
    before = client.get("/api/disputes").json()
    with respx.mock(assert_all_called=False) as router:
        r = client.post(f"/api/disputes/{d['id']}/paypal-invoice")
        assert len(router.calls) == 0
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "demo"
    assert body["demo"] is True
    assert body["mode"] == "demo"
    assert body["label"] == DEMO_LABEL
    assert body["debug_id"] is None
    assert body["invoice_id"].startswith("DEMO-INV-")
    assert body["status"] == "DRAFT"
    assert body["fields"]["total"] == {"currency_code": "EUR", "value": "128.00"}
    assert body["already_recorded"] is False
    assert not any(k.startswith("score") for k in body)
    after = {x["id"]: x["win_probability"] for x in client.get("/api/disputes").json()}
    assert after[d["id"]] == {x["id"]: x["win_probability"] for x in before}[d["id"]] == 79
    last = actions(client, d["id"])[-1]
    assert last["action"] == "invoice_recorded"
    assert last["detail"]["source"] == "demo"
    assert last["detail"]["invoice_id"] == body["invoice_id"]
    assert not any(k.startswith("score") for k in last["detail"])


@pytest.mark.parametrize("n", range(5))
def test_recording_an_invoice_never_changes_the_score(client: TestClient, n: int) -> None:
    d = seed_demo(client)[n]
    plain = client.get(f"/api/disputes/{d['id']}/score").json()
    grid = {x["id"]: x["win_probability"] for x in client.get("/api/disputes").json()}[d["id"]]
    assert client.post(f"/api/disputes/{d['id']}/paypal-invoice").status_code == 200
    score = client.get(f"/api/disputes/{d['id']}/score").json()
    assert score["probability"] == plain["probability"] == grid
    assert score["factors"] == plain["factors"]
    assert score["base"] == plain["base"]
    assert not any("nvoice" in f["label"] for f in score["factors"])
    assert {x["id"]: x["win_probability"] for x in client.get("/api/disputes").json()}[d["id"]] == grid


def test_demo_fixture_is_deterministic_and_repeat_is_idempotent(client: TestClient) -> None:
    d = seed_demo(client)[1]
    first = client.post(f"/api/disputes/{d['id']}/paypal-invoice").json()
    again = client.post(f"/api/disputes/{d['id']}/paypal-invoice").json()
    assert again["already_recorded"] is True
    assert again["invoice_id"] == first["invoice_id"]
    assert [a["action"] for a in actions(client, d["id"])].count("invoice_recorded") == 1


def test_demo_fixture_invoice_stays_out_of_the_dossier_note(client: TestClient) -> None:
    d = seed_demo(client)[1]
    before = client.get(f"/api/disputes/{d['id']}/score").json()["dossier"]
    body = client.post(f"/api/disputes/{d['id']}/paypal-invoice").json()
    after = client.get(f"/api/disputes/{d['id']}/score").json()["dossier"]
    assert after["note"] == before["note"]
    assert "Order record" not in after["note"] and body["invoice_number"] not in after["note"]


def test_paypal_dispute_without_keys_is_409(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PAYPAL_CLIENT_ID")
    monkeypatch.delenv("PAYPAL_CLIENT_SECRET")
    did = paypal_row()
    r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 409
    assert r.json()["detail"] == NO_KEYS


# ---- route: live (mocked) ----


def test_paypal_dispute_creates_and_reads_back_the_invoice(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_creds(monkeypatch)
    did = paypal_row()
    with respx.mock() as router:
        create, get = mock_invoice(router)
        r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live sandbox"
    assert body["demo"] is False
    assert body["mode"] == "paypal"
    assert body["label"] == "Recorded on PayPal sandbox"
    assert body["debug_id"] == "dbg-create"
    assert body["invoice_id"] == INVOICE_BODY["id"]
    assert body["fields"]["invoice_number"] == "0042"
    assert body["fields"]["recipient"] == "Jo Smith"
    assert body["status"] == "DRAFT"
    assert create.called and get.called
    sent = json.loads(create.calls.last.request.content)
    assert sent["items"][0]["unit_amount"] == AMT
    last = actions(client, did)[-1]
    assert last["action"] == "invoice_recorded"
    assert last["detail"]["debug_id"] == "dbg-create"
    assert last["detail"]["source"] == "live sandbox"
    # repeat makes no second PayPal call
    with respx.mock(assert_all_called=False) as router:
        again = client.post(f"/api/disputes/{did}/paypal-invoice").json()
        assert len(router.calls) == 0
    assert again["already_recorded"] is True
    assert again["debug_id"] == "dbg-create"


def test_paypal_failure_is_502_with_debug_id_and_audited(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_creds(monkeypatch)
    did = paypal_row()
    with respx.mock() as router:
        token_ok(router)
        router.post(INV).mock(return_value=httpx.Response(422, json={"name": "UNPROCESSABLE", "message": "no", "debug_id": "dbgF"}))
        r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 502
    assert r.json()["detail"]["debug_id"] == "dbgF"
    assert r.json()["detail"]["paypal_name"] == "UNPROCESSABLE"
    last = actions(client, did)[-1]
    assert last["action"] == "invoice_failed"
    assert last["detail"]["debug_id"] == "dbgF"
    # a failure records nothing, so a retry is allowed
    with respx.mock(assert_all_called=False) as router:
        mock_invoice(router)
        assert client.post(f"/api/disputes/{did}/paypal-invoice").status_code == 200


def test_paypal_dispute_on_a_live_base_is_refused(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_creds(monkeypatch)
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    did = paypal_row()
    with respx.mock(assert_all_called=False) as router:
        r = client.post(f"/api/disputes/{did}/paypal-invoice")
        assert len(router.calls) == 0
    assert r.status_code == 502
    assert "sandbox" in r.json()["detail"]["message"]


# ---- live sandbox ----


def test_live_sandbox_creates_and_reads_an_invoice(monkeypatch: pytest.MonkeyPatch) -> None:
    real_creds(monkeypatch)
    rec = run(paypal.record_invoice("DisputeShield test order", AMT, recipient_name="Test Buyer"))
    assert rec["invoice_id"].startswith("INV2-")
    assert rec["status"] == "DRAFT"
    assert rec["total"]["value"] == "49.90"
    assert rec["debug_id"]
    assert rec["lookup_debug_id"]
    assert rec["verified"] is True


def test_live_sandbox_unknown_invoice_is_a_404_with_debug_id(monkeypatch: pytest.MonkeyPatch) -> None:
    real_creds(monkeypatch)
    with pytest.raises(PayPalError) as ei:
        run(paypal.get_invoice("INV2-0000-0000-0000-0000"))
    assert ei.value.status in (400, 404)
    assert ei.value.debug_id
    assert ei.value.debug_id in str(ei.value)


def test_live_sandbox_route_records_for_a_paypal_dispute(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    real_creds(monkeypatch)
    did = paypal_row("PP-D-LIVE-INV")
    r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live sandbox"
    assert body["demo"] is False
    assert body["debug_id"]
    assert body["invoice_id"].startswith("INV2-")
    last = actions(client, did)[-1]
    assert last["action"] == "invoice_recorded"
    assert last["detail"]["debug_id"] == body["debug_id"]
