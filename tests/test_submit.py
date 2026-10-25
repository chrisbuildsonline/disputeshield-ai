import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import paypal
from app.main import app

ROOT = Path(__file__).parent.parent
SAMPLES = ROOT / "samples"
FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"
DID = "PP-000-042-663-135"
BASE = "https://api-m.sandbox.paypal.com"
TOKEN_URL = f"{BASE}/v1/oauth2/token"
D = f"{BASE}/v1/customer/disputes"
REAL_ID = os.environ.get("PAYPAL_CLIENT_ID", "")  # from .env via conftest, before any monkeypatch
REAL_SECRET = os.environ.get("PAYPAL_CLIENT_SECRET", "")
DEMO_LABEL = "Demo mode: nothing was sent to PayPal"


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


def event(**resource: Any) -> dict[str, Any]:
    e: dict[str, Any] = json.loads(FIXTURE.read_text())
    e["resource"].update(resource)
    return e


def ingest(client: TestClient, **resource: Any) -> str:
    e = event(**resource)
    e["id"] = f"WH-{resource.get('dispute_id', DID)}-{resource.get('status', '')}"
    assert client.post("/api/webhooks/paypal", json=e).status_code == 200
    return str(e["resource"]["dispute_id"])


def upload(client: TestClient, did: str, name: str = "ups_receipt.pdf", data: bytes | None = None) -> Any:
    body = data if data is not None else (SAMPLES / name).read_bytes()
    return client.post(
        f"/api/disputes/{did}/documents", params={"name": name}, content=body, headers={"content-type": "application/pdf"}
    )


def ready(client: TestClient) -> str:
    did = ingest(client)
    assert upload(client, did).status_code == 200
    return did


def actions(client: TestClient, did: str) -> list[str]:
    return [a["action"] for a in client.get(f"/api/disputes/{did}/audit").json()]


def paypal_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")


def mock_token(router: respx.MockRouter) -> None:
    router.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}))


def synced_paypal_dispute(client: TestClient, router: respx.MockRouter) -> str:
    mock_token(router)
    router.get(D).mock(return_value=httpx.Response(200, json={"items": [{"dispute_id": DID}]}))
    router.get(f"{D}/{DID}").mock(return_value=httpx.Response(200, json=event()["resource"]))
    r = client.post("/api/disputes/sync")
    assert r.status_code == 200, r.text
    return DID


# ---- source ----


def test_webhook_dispute_is_simulated(client: TestClient) -> None:
    did = ingest(client)
    assert client.get(f"/api/disputes/{did}").json()["source"] == "simulated"
    assert client.get("/api/disputes").json()[0]["source"] == "simulated"


def test_old_db_without_source_column_is_migrated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    old = tmp_path / "old.db"
    with sqlite3.connect(old) as conn:
        conn.execute(
            "CREATE TABLE disputes (id TEXT PRIMARY KEY, reason TEXT, status TEXT, amount_value TEXT, currency TEXT, "
            "create_time TEXT, update_time TEXT, seller_response_due_date TEXT, outcome TEXT, resource TEXT NOT NULL, "
            "received_at TEXT NOT NULL)"
        )
        conn.execute("INSERT INTO disputes (id, resource, received_at) VALUES ('OLD-1', '{}', 'x')")
    conn.close()
    monkeypatch.setenv("DISPUTESHIELD_DB", str(old))
    assert client.get("/api/disputes/OLD-1").json()["source"] == "simulated"
    assert ingest(client) == DID
    assert {d["id"] for d in client.get("/api/disputes").json()} == {"OLD-1", DID}


# ---- documents ----


def test_upload_then_list_documents(client: TestClient) -> None:
    did = ingest(client)
    r = upload(client, did)
    assert r.status_code == 200
    docs = client.get(f"/api/disputes/{did}/documents").json()
    assert len(docs) == 1
    assert docs[0]["name"] == "ups_receipt.pdf"
    assert docs[0]["size"] == len((SAMPLES / "ups_receipt.pdf").read_bytes())
    assert docs[0]["evidence"]["source"] == "fallback"
    assert docs[0]["evidence"]["tracking_number"]
    assert "data" not in docs[0]
    assert actions(client, did) == ["document_added"]


def test_upload_unknown_dispute_404(client: TestClient) -> None:
    assert upload(client, "NOPE").status_code == 404
    assert client.get("/api/disputes/NOPE/documents").status_code == 404
    assert client.get("/api/disputes/NOPE/audit").status_code == 404


@pytest.mark.parametrize(
    ("name", "data", "code"),
    [
        ("ups_receipt.pdf", b"not a pdf", 422),
        ("../evil.pdf", b"%PDF-1.4 x", 422),
        ("bad name!.pdf", b"%PDF-1.4 x", 422),
        ("receipt.pdf\n", b"%PDF-1.4 x", 422),
        ("noext", b"%PDF-1.4 x", 422),
        ("x.exe", b"%PDF-1.4 x", 422),
        ("x.pdf", b"", 422),
        ("x.pdf", b"%PDF-" + b"0" * (10 * 1024 * 1024), 413),
    ],
)
def test_bad_uploads_are_4xx(client: TestClient, name: str, data: bytes, code: int) -> None:
    did = ingest(client)
    assert upload(client, did, name, data).status_code == code
    assert client.get(f"/api/disputes/{did}/documents").json() == []


def test_upload_without_name_is_422(client: TestClient) -> None:
    did = ingest(client)
    r = client.post(f"/api/disputes/{did}/documents", content=b"%PDF-1.4", headers={"content-type": "application/pdf"})
    assert r.status_code == 422


@settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(data=st.binary(max_size=2000), name=st.text(max_size=40), pdf_prefix=st.booleans())
def test_fuzz_documents_never_500(client: TestClient, data: bytes, name: str, pdf_prefix: bool) -> None:
    did = ingest(client)
    body = b"%PDF-" + data if pdf_prefix else data
    r = client.post(f"/api/disputes/{did}/documents", params={"name": name}, content=body)
    assert r.status_code < 500


# ---- submit: demo mode ----


def test_submit_demo_mode(client: TestClient) -> None:
    did = ready(client)
    r = client.post(f"/api/disputes/{did}/submit")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "demo"
    assert body["demo"] is True
    assert body["label"] == DEMO_LABEL
    assert body["status"] == "UNDER_REVIEW"
    assert body["paypal_response"] is None
    assert body["note_source"] == "template"
    assert isinstance(body["submission_id"], int)
    assert 0 <= body["probability"] <= 100
    assert client.get(f"/api/disputes/{did}").json()["status"] == "UNDER_REVIEW"
    assert actions(client, did) == ["document_added", "submitted"]


def test_demo_mode_makes_no_network_call(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    did = ready(client)
    with respx.mock(assert_all_called=False) as router:
        any_call = router.route().mock(return_value=httpx.Response(500))
        assert client.post(f"/api/disputes/{did}/submit").status_code == 200
    assert not any_call.called


def test_paypal_source_without_keys_stays_demo(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    paypal_creds(monkeypatch)
    with respx.mock(assert_all_called=False) as router:
        did = synced_paypal_dispute(client, router)
    monkeypatch.delenv("PAYPAL_CLIENT_ID")
    assert upload(client, did).status_code == 200
    assert client.post(f"/api/disputes/{did}/submit").json()["mode"] == "demo"


def test_second_submit_is_409_and_audited(client: TestClient) -> None:
    did = ready(client)
    assert client.post(f"/api/disputes/{did}/submit").status_code == 200
    r = client.post(f"/api/disputes/{did}/submit")
    assert r.status_code == 409
    assert actions(client, did) == ["document_added", "submitted", "submit_refused"]
    refused = client.get(f"/api/disputes/{did}/audit").json()[-1]
    assert "already" in refused["detail"]["reason"]


def test_closed_dispute_is_409(client: TestClient) -> None:
    did = ingest(client, status="RESOLVED", dispute_outcome={"outcome_code": "RESOLVED_SELLER_FAVOUR"})
    assert upload(client, did).status_code == 200
    assert client.post(f"/api/disputes/{did}/submit").status_code == 409
    assert actions(client, did)[-1] == "submit_refused"


def test_no_documents_is_422(client: TestClient) -> None:
    did = ingest(client)
    assert client.post(f"/api/disputes/{did}/submit").status_code == 422
    assert actions(client, did) == ["submit_refused"]


def test_unknown_dispute_is_404(client: TestClient) -> None:
    assert client.post("/api/disputes/NOPE/submit").status_code == 404


def test_concurrent_submits_exactly_one_wins(client: TestClient) -> None:
    did = ready(client)
    barrier = Barrier(2)

    def go() -> int:
        barrier.wait()
        return client.post(f"/api/disputes/{did}/submit").status_code

    with ThreadPoolExecutor(2) as pool:
        codes = sorted(f.result() for f in [pool.submit(go), pool.submit(go)])
    assert codes == [200, 409]
    assert actions(client, did).count("submitted") == 1


# ---- submit: paypal mode ----


def test_submit_paypal_mode_stores_new_status(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    paypal_creds(monkeypatch)
    with respx.mock() as router:
        did = synced_paypal_dispute(client, router)
        assert client.get(f"/api/disputes/{did}").json()["source"] == "paypal"
        assert upload(client, did).status_code == 200
        evidence = router.post(f"{D}/{did}/provide-evidence").mock(return_value=httpx.Response(200, json={"links": []}))
        router.get(f"{D}/{did}").mock(
            return_value=httpx.Response(200, json=event(status="WAITING_FOR_BUYER_RESPONSE")["resource"])
        )
        r = client.post(f"/api/disputes/{did}/submit")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["demo"]) == ("paypal", False)
    assert "PayPal sandbox" in body["label"]
    assert body["status"] == "WAITING_FOR_BUYER_RESPONSE"
    assert body["paypal_response"] == {"links": []}
    assert evidence.call_count == 1
    assert client.get(f"/api/disputes/{did}").json()["status"] == "WAITING_FOR_BUYER_RESPONSE"


def test_paypal_error_is_502_releases_claim_and_retry_works(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    paypal_creds(monkeypatch)
    err = {"name": "INVALID_REQUEST", "message": "nope", "debug_id": "dbg123"}
    with respx.mock() as router:
        did = synced_paypal_dispute(client, router)
        assert upload(client, did).status_code == 200
        router.post(f"{D}/{did}/provide-evidence").mock(
            side_effect=[httpx.Response(400, json=err), httpx.Response(200, json={"links": []})]
        )
        router.get(f"{D}/{did}").mock(return_value=httpx.Response(200, json=event(status="UNDER_REVIEW")["resource"]))
        first = client.post(f"/api/disputes/{did}/submit")
        assert first.status_code == 502
        detail = first.json()["detail"]
        assert detail["debug_id"] == "dbg123"
        assert detail["paypal_name"] == "INVALID_REQUEST"
        assert "nope" in detail["message"]
        assert actions(client, did)[-1] == "submit_failed"
        second = client.post(f"/api/disputes/{did}/submit")
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "UNDER_REVIEW"
    assert actions(client, did)[-1] == "submitted"


# ---- sync ----


def test_sync_without_keys_is_409(client: TestClient) -> None:
    r = client.post("/api/disputes/sync")
    assert r.status_code == 409
    assert "PayPal keys not set" in r.text


def test_sync_upserts_with_paypal_source_and_audits(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    paypal_creds(monkeypatch)
    with respx.mock() as router:
        did = synced_paypal_dispute(client, router)
    assert client.get("/api/disputes").json()[0]["source"] == "paypal"
    assert actions(client, did) == ["synced"]


def test_sync_keeps_newer_stored_dispute(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    did = ingest(client, status="WAITING_FOR_SELLER_RESPONSE", update_time="2030-01-01T00:00:00.000Z")
    paypal_creds(monkeypatch)
    with respx.mock() as router:
        synced_paypal_dispute(client, router)
    assert client.get(f"/api/disputes/{did}").json()["status"] == "WAITING_FOR_SELLER_RESPONSE"


def test_demo_webhook_does_not_downgrade_paypal_source(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    paypal_creds(monkeypatch)
    with respx.mock() as router:
        did = synced_paypal_dispute(client, router)
    ingest(client, status="WAITING_FOR_SELLER_RESPONSE", update_time="2030-01-01T00:00:00.000Z")
    assert client.get(f"/api/disputes/{did}").json()["source"] == "paypal"


# ---- live sandbox ----


def test_live_sandbox_sync_returns_a_list(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    if not (REAL_ID and REAL_SECRET):
        pytest.fail("Needs fix: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", REAL_ID)
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", REAL_SECRET)
    r = client.post("/api/disputes/sync")
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)
