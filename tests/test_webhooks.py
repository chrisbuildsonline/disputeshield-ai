import copy
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError
from starlette.requests import Request

from app import paypal, webhooks
from app.main import app

FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"
URL = "/api/webhooks/paypal"
BASE = "https://api-m.sandbox.paypal.com"
VERIFY_URL = f"{BASE}/v1/notifications/verify-webhook-signature"
TOKEN_URL = f"{BASE}/v1/oauth2/token"
SIG_HEADERS = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "c2ln",
    "paypal-transmission-time": "2018-01-12T10:41:36Z",
}


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    monkeypatch.delenv("PAYPAL_WEBHOOK_ID", raising=False)
    monkeypatch.delenv("PAYPAL_API_BASE", raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    paypal._token = None


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def created() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(FIXTURE.read_text())
    return data


def updated() -> dict[str, Any]:
    e = created()
    e["id"] = "WH-UPDATED-1"
    e["event_type"] = "CUSTOMER.DISPUTE.UPDATED"
    e["resource"]["status"] = "WAITING_FOR_SELLER_RESPONSE"
    e["resource"]["update_time"] = "2018-01-13T09:00:00.000Z"
    e["resource"]["seller_response_due_date"] = "2018-01-20T09:00:00.000Z"
    return e


def resolved() -> dict[str, Any]:
    e = created()
    e["id"] = "WH-RESOLVED-1"
    e["event_type"] = "CUSTOMER.DISPUTE.RESOLVED"
    e["resource"]["status"] = "RESOLVED"
    e["resource"]["update_time"] = "2018-01-15T09:00:00.000Z"
    e["resource"]["dispute_outcome"] = {"outcome_code": "RESOLVED_SELLER_FAVOUR"}
    return e


def test_created_then_list_then_detail(client: TestClient) -> None:
    r = client.post(URL, json=created())
    assert r.status_code == 200
    assert r.json() == {
        "ok": True,
        "dispute_id": "PP-000-042-663-135",
        "verified": False,
        "mode": "demo",
    }
    rows = client.get("/api/disputes").json()
    assert len(rows) == 1
    assert rows[0]["id"] == "PP-000-042-663-135"
    assert rows[0]["status"] == "OPEN"
    assert rows[0]["amount_value"] == "3.00"
    assert rows[0]["currency"] == "USD"
    assert rows[0]["reason"] == "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
    assert "resource" not in rows[0]
    d = client.get("/api/disputes/PP-000-042-663-135").json()
    assert d["resource"]["disputed_transactions"][0]["seller_protection_eligible"]
    assert d["resource"]["messages"][0]["content"] == "item not received"


def test_updated_changes_status(client: TestClient) -> None:
    client.post(URL, json=created())
    assert client.post(URL, json=updated()).status_code == 200
    d = client.get("/api/disputes/PP-000-042-663-135").json()
    assert d["status"] == "WAITING_FOR_SELLER_RESPONSE"
    assert d["seller_response_due_date"] == "2018-01-20T09:00:00.000Z"


def test_resolved_stores_outcome(client: TestClient) -> None:
    client.post(URL, json=created())
    assert client.post(URL, json=resolved()).status_code == 200
    d = client.get("/api/disputes/PP-000-042-663-135").json()
    assert d["status"] == "RESOLVED"
    assert d["outcome"] == "RESOLVED_SELLER_FAVOUR"


def test_duplicate_is_idempotent(client: TestClient) -> None:
    client.post(URL, json=created())
    r = client.post(URL, json=created())
    assert r.status_code == 200
    assert r.json() == {"duplicate": True}
    assert len(client.get("/api/disputes").json()) == 1


def test_out_of_order_does_not_overwrite(client: TestClient) -> None:
    client.post(URL, json=resolved())
    r = client.post(URL, json=updated())
    assert r.status_code == 200
    assert client.get("/api/disputes/PP-000-042-663-135").json()["status"] == "RESOLVED"
    again = client.post(URL, json=updated())
    assert again.json() == {"duplicate": True}


def test_list_newest_first(client: TestClient) -> None:
    client.post(URL, json=created())
    other = resolved()
    other["id"] = "WH-OTHER"
    other["resource"]["dispute_id"] = "PP-OTHER"
    client.post(URL, json=other)
    assert [d["id"] for d in client.get("/api/disputes").json()] == [
        "PP-OTHER",
        "PP-000-042-663-135",
    ]


def test_unknown_event_ignored(client: TestClient) -> None:
    e = {"id": "WH-X", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {}}
    r = client.post(URL, json=e)
    assert r.status_code == 200
    assert r.json() == {"ignored": True}
    assert client.get("/api/disputes").json() == []


def test_detail_404(client: TestClient) -> None:
    assert client.get("/api/disputes/nope").status_code == 404


def no_id() -> dict[str, Any]:
    e = created()
    del e["id"]
    return e


def no_type() -> dict[str, Any]:
    e = created()
    del e["event_type"]
    return e


def no_dispute_id() -> dict[str, Any]:
    e = created()
    del e["resource"]["dispute_id"]
    return e


def string_resource() -> dict[str, Any]:
    e = created()
    e["resource"] = "oops"
    return e


def bad_amount() -> dict[str, Any]:
    e = created()
    e["resource"]["dispute_amount"] = {"currency_code": "USD", "value": 3.0}
    return e


def int_id() -> dict[str, Any]:
    e = created()
    e["id"] = 5
    return e


@pytest.mark.parametrize("make", [no_id, no_type, no_dispute_id, string_resource, bad_amount, int_id])
def test_malformed_events_422(client: TestClient, make: Any) -> None:
    assert client.post(URL, json=make()).status_code == 422
    assert client.get("/api/disputes").json() == []


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"",
        b"[]",
        b'"str"',
        b"null",
        b"42",
        b"\xff\xfe",
        b'{"id": "\\ud800", "event_type": "X", "resource": {}}',
        b"[" * 100_000 + b"]" * 100_000,
    ],
)
def test_malformed_bodies_422(client: TestClient, body: bytes) -> None:
    r = client.post(URL, content=body, headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_body_over_1mb_413(client: TestClient) -> None:
    e = created()
    e["resource"]["messages"][0]["content"] = "x" * (1024 * 1024)
    assert client.post(URL, json=e).status_code == 413
    assert client.get("/api/disputes").json() == []


def test_chunked_body_over_1mb_413_without_buffering(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def no_body(self: Request) -> bytes:
        raise AssertionError("request.body() buffers the whole payload")

    monkeypatch.setattr(Request, "body", no_body)

    def chunks() -> Iterator[bytes]:
        for _ in range(50):
            yield b"x" * 100_000

    r = client.post(URL, content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert "content-length" not in r.request.headers


def test_fails_closed_when_nothing_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE", raising=False)
    r = client.post(URL, json=created())
    assert r.status_code == 503
    assert r.json() == {"detail": "webhook verification not configured"}
    assert client.get("/api/disputes").json() == []


def test_demo_flag_other_than_1_fails_closed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "true")
    assert client.post(URL, json=created()).status_code == 503


def test_parse_event_dispute_fields() -> None:
    event, res = webhooks.parse_event(created())
    assert event.id == "WH-4M0448861G563140B-9EX36365822141321"
    assert res is not None
    assert res.dispute_id == "PP-000-042-663-135"
    assert res.dispute_amount is not None
    assert res.dispute_amount.value == "3.00"


def test_parse_event_unknown_has_no_dispute() -> None:
    _, res = webhooks.parse_event({"id": "a", "event_type": "OTHER", "resource": {}})
    assert res is None


def test_parse_event_rejects_missing_dispute_id() -> None:
    with pytest.raises(ValidationError):
        webhooks.parse_event(no_dispute_id())


# signature verification

@pytest.fixture
def verified_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_WEBHOOK_ID", "WEBHOOK-ID")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "cid")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")


def token_route(mock: respx.MockRouter) -> respx.Route:
    return mock.post(TOKEN_URL).respond(json={"access_token": "tok", "expires_in": 3600})


@pytest.mark.usefixtures("verified_env")
def test_signature_success(client: TestClient) -> None:
    with respx.mock(assert_all_called=True) as mock:
        token = token_route(mock)
        verify = mock.post(VERIFY_URL).respond(json={"verification_status": "SUCCESS"})
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 200
    assert r.json()["verified"] is True
    assert r.json()["mode"] == "verified"
    sent = json.loads(verify.calls.last.request.content)
    assert sent["webhook_id"] == "WEBHOOK-ID"
    assert sent["transmission_id"] == "tx-1"
    assert sent["auth_algo"] == "SHA256withRSA"
    assert sent["cert_url"] == SIG_HEADERS["paypal-cert-url"]
    assert sent["transmission_sig"] == "c2ln"
    assert sent["transmission_time"] == "2018-01-12T10:41:36Z"
    assert sent["webhook_event"] == created()
    assert verify.calls.last.request.headers["authorization"] == "Bearer tok"
    req = token.calls.last.request
    assert req.headers["authorization"].startswith("Basic ")
    assert b"grant_type=client_credentials" in req.content
    assert len(client.get("/api/disputes").json()) == 1


@pytest.mark.usefixtures("verified_env")
def test_signature_failure_401(client: TestClient) -> None:
    with respx.mock() as mock:
        token_route(mock)
        mock.post(VERIFY_URL).respond(json={"verification_status": "FAILURE"})
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 401
    assert client.get("/api/disputes").json() == []


@pytest.mark.usefixtures("verified_env")
def test_missing_signature_headers_401(client: TestClient) -> None:
    with respx.mock() as mock:
        assert client.post(URL, json=created()).status_code == 401
        assert not mock.calls


@pytest.mark.usefixtures("verified_env")
def test_paypal_unreachable_503(client: TestClient) -> None:
    with respx.mock() as mock:
        mock.post(TOKEN_URL).mock(side_effect=httpx.ConnectError("down"))
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 503
    assert client.get("/api/disputes").json() == []


@pytest.mark.usefixtures("verified_env")
def test_paypal_verify_5xx_503(client: TestClient) -> None:
    with respx.mock() as mock:
        token_route(mock)
        mock.post(VERIFY_URL).respond(status_code=502)
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 503


@pytest.mark.usefixtures("verified_env")
def test_paypal_token_5xx_503(client: TestClient) -> None:
    with respx.mock() as mock:
        mock.post(TOKEN_URL).respond(status_code=500)
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 503


@pytest.mark.usefixtures("verified_env")
def test_token_is_cached(client: TestClient) -> None:
    with respx.mock() as mock:
        token = token_route(mock)
        mock.post(VERIFY_URL).respond(json={"verification_status": "SUCCESS"})
        client.post(URL, json=created(), headers=SIG_HEADERS)
        client.post(URL, json=updated(), headers=SIG_HEADERS)
    assert token.call_count == 1


@pytest.mark.usefixtures("verified_env")
def test_custom_api_base(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com/")
    with respx.mock(assert_all_called=True) as mock:
        mock.post("https://api-m.paypal.com/v1/oauth2/token").respond(
            json={"access_token": "t", "expires_in": 3600}
        )
        mock.post("https://api-m.paypal.com/v1/notifications/verify-webhook-signature").respond(
            json={"verification_status": "SUCCESS"}
        )
        r = client.post(URL, json=created(), headers=SIG_HEADERS)
    assert r.status_code == 200


# fuzz

json_values = st.recursive(
    st.none()
    | st.booleans()
    | st.integers()
    | st.floats(allow_nan=False, allow_infinity=False)
    | st.text(),
    lambda children: st.lists(children, max_size=4)
    | st.dictionaries(st.text(max_size=10), children, max_size=4),
    max_leaves=15,
)

junk = json_values

event_like = st.fixed_dictionaries(
    {},
    optional={
        "id": junk,
        "event_type": st.sampled_from(
            ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED", "X"]
        )
        | junk,
        "resource": st.fixed_dictionaries(
            {},
            optional={
                "dispute_id": junk,
                "reason": junk,
                "status": junk,
                "dispute_amount": junk,
                "create_time": junk,
                "update_time": junk,
                "seller_response_due_date": junk,
                "dispute_life_cycle_stage": junk,
                "dispute_outcome": junk,
            },
        )
        | junk,
    },
)

fuzz_settings = settings(
    max_examples=100, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)


@fuzz_settings
@given(value=json_values)
def test_fuzz_arbitrary_json_never_500(value: Any) -> None:
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post(URL, content=json.dumps(value), headers={"content-type": "application/json"})
    assert r.status_code in (200, 413, 422)


@fuzz_settings
@given(value=event_like)
def test_fuzz_event_shaped_never_500(value: dict[str, Any]) -> None:
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post(URL, content=json.dumps(value), headers={"content-type": "application/json"})
    assert r.status_code in (200, 413, 422)


@fuzz_settings
@given(value=st.one_of(json_values, event_like))
def test_fuzz_parse_event_only_validation_errors(value: Any) -> None:
    try:
        webhooks.parse_event(copy.deepcopy(value))
    except ValidationError:
        pass
