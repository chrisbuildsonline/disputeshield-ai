import asyncio
import json
import os
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

import httpx
import pytest
import respx

from app import paypal
from app.dossier import FILE_PART, INPUT_PART, Dossier
from app.paypal import PayPalError

BASE = "https://api-m.sandbox.paypal.com"
TOKEN_URL = f"{BASE}/v1/oauth2/token"
D = f"{BASE}/v1/customer/disputes"
T = TypeVar("T")
REAL_ID = os.environ.get("PAYPAL_CLIENT_ID", "")  # from .env via conftest, before any monkeypatch
REAL_SECRET = os.environ.get("PAYPAL_CLIENT_SECRET", "")


def run(coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")
    monkeypatch.delenv("PAYPAL_API_BASE", raising=False)
    paypal._token = None


def token_ok(router: respx.MockRouter) -> respx.Route:
    return router.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}))


def dossier() -> Dossier:
    return Dossier(
        input={"evidences": [{"evidence_type": "OTHER", "notes": "hello"}]},
        files=[("receipt.pdf", b"%PDF-1.4 fake"), ("photo.png", b"\x89PNG\r\n\x1a\nxx")],
        note_source="template",
    )


# ---- list / show ----


def test_list_disputes_success_and_params() -> None:
    with respx.mock(assert_all_called=False) as router:
        token_ok(router)
        route = router.get(D).mock(return_value=httpx.Response(200, json={"items": [{"dispute_id": "PP-D-1"}]}))
        out = run(paypal.list_disputes(page_size=5, disputed_transaction_id="TX1", start_time="2026-01-01T00:00:00.000Z"))
    assert out == {"items": [{"dispute_id": "PP-D-1"}]}
    req = route.calls.last.request
    assert req.headers["authorization"] == "Bearer tok"
    assert req.url.params["page_size"] == "5"
    assert req.url.params["disputed_transaction_id"] == "TX1"
    assert req.url.params["start_time"] == "2026-01-01T00:00:00.000Z"


def test_list_disputes_no_filters_sends_no_params() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.get(D).mock(return_value=httpx.Response(200, json={}))
        assert run(paypal.list_disputes()) == {}
    assert route.calls.last.request.url.query == b""


def test_show_dispute_success() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-12345").mock(return_value=httpx.Response(200, json={"dispute_id": "PP-D-12345"}))
        assert run(paypal.show_dispute("PP-D-12345")) == {"dispute_id": "PP-D-12345"}


# ---- provide_evidence ----


def test_provide_evidence_sends_multipart() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-12345/provide-evidence").mock(return_value=httpx.Response(200, json={"links": []}))
        run(paypal.provide_evidence("PP-D-12345", dossier()))
    req = route.calls.last.request
    assert req.headers["content-type"].startswith("multipart/form-data; boundary=")
    assert req.headers["authorization"] == "Bearer tok"
    body = req.content
    assert f'name="{INPUT_PART}"'.encode() in body
    assert b"Content-Type: application/json" in body
    assert json.dumps(dossier().input).encode() in body or b'"evidence_type"' in body
    assert f'name="{FILE_PART}1"; filename="receipt.pdf"'.encode() in body
    assert f'name="{FILE_PART}2"; filename="photo.png"'.encode() in body
    assert b"Content-Type: application/pdf" in body
    assert b"Content-Type: image/png" in body
    assert b"%PDF-1.4 fake" in body


def test_provide_evidence_input_part_is_valid_json() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-1/provide-evidence").mock(return_value=httpx.Response(200, json={}))
        run(paypal.provide_evidence("PP-D-1", dossier()))
    body = route.calls.last.request.content
    start = body.index(b'name="input"')
    payload = body[body.index(b"\r\n\r\n", start) + 4 :]
    payload = payload[: payload.index(b"\r\n--")]
    assert json.loads(payload) == dossier().input


# ---- errors ----


def test_error_surfaces_status_name_message_debug_id() -> None:
    err = {"name": "RESOURCE_NOT_FOUND", "message": "Requested resource ID was not found.", "debug_id": "abc123"}
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(return_value=httpx.Response(404, json=err))
        with pytest.raises(PayPalError) as ei:
            run(paypal.show_dispute("PP-D-9"))
    e = ei.value
    assert (e.status, e.name, e.debug_id) == (404, "RESOURCE_NOT_FOUND", "abc123")
    for part in ("404", "RESOURCE_NOT_FOUND", "Requested resource ID was not found.", "abc123"):
        assert part in str(e)


def test_debug_id_falls_back_to_header() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(
            return_value=httpx.Response(400, json={"name": "BAD", "message": "nope"}, headers={"Paypal-Debug-Id": "hdr42"})
        )
        with pytest.raises(PayPalError) as ei:
            run(paypal.show_dispute("PP-D-9"))
    assert ei.value.debug_id == "hdr42"
    assert "hdr42" in str(ei.value)


@pytest.mark.parametrize("body", [b"<html>bad gateway</html>", b"", b"[1, 2]", b'"str"'])
def test_non_json_error_body(body: bytes) -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(return_value=httpx.Response(502, content=body, headers={"paypal-debug-id": "h1"}))
        with pytest.raises(PayPalError) as ei:
            run(paypal.show_dispute("PP-D-9"))
    assert ei.value.status == 502
    assert ei.value.debug_id == "h1"
    assert "502" in str(ei.value)


def test_non_json_success_body_is_paypal_error() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(return_value=httpx.Response(200, content=b"not json"))
        with pytest.raises(PayPalError):
            run(paypal.show_dispute("PP-D-9"))


def test_timeout_becomes_paypal_error() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(side_effect=httpx.ReadTimeout("slow"))
        with pytest.raises(PayPalError, match="timed out"):
            run(paypal.show_dispute("PP-D-9"))


def test_network_error_becomes_paypal_error() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(f"{D}/PP-D-9").mock(side_effect=httpx.ConnectError("down"))
        with pytest.raises(PayPalError):
            run(paypal.show_dispute("PP-D-9"))


def test_token_timeout_becomes_paypal_error() -> None:
    with respx.mock() as router:
        router.post(TOKEN_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
        with pytest.raises(PayPalError):
            run(paypal.show_dispute("PP-D-9"))


def test_401_clears_token_and_retries_once() -> None:
    with respx.mock() as router:
        tok = router.post(TOKEN_URL).mock(
            side_effect=[
                httpx.Response(200, json={"access_token": "old", "expires_in": 3600}),
                httpx.Response(200, json={"access_token": "new", "expires_in": 3600}),
            ]
        )
        route = router.get(f"{D}/PP-D-9").mock(
            side_effect=[httpx.Response(401, json={"name": "AUTHENTICATION_FAILURE"}), httpx.Response(200, json={"ok": 1})]
        )
        assert run(paypal.show_dispute("PP-D-9")) == {"ok": 1}
    assert tok.call_count == 2
    assert [c.request.headers["authorization"] for c in route.calls] == ["Bearer old", "Bearer new"]


def test_401_twice_raises_after_one_retry() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.get(f"{D}/PP-D-9").mock(return_value=httpx.Response(401, json={"name": "AUTHENTICATION_FAILURE"}))
        with pytest.raises(PayPalError) as ei:
            run(paypal.show_dispute("PP-D-9"))
    assert route.call_count == 2
    assert ei.value.status == 401


# ---- id validation ----


BAD_IDS = ["", "../x", "PP-D-1/../../x", "PP-D-1?x=1", "PP D 1", "PP-D-1#f", "PP-D-1\n", "a/b", "%2e%2e", "PP_D", "é"]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_bad_ids_rejected_without_http(bad: str) -> None:
    calls: list[Callable[[], Coroutine[Any, Any, Any]]] = [
        lambda: paypal.show_dispute(bad),
        lambda: paypal.provide_evidence(bad, dossier()),
        lambda: paypal.require_evidence(bad, "BUYER_EVIDENCE"),
        lambda: paypal.adjudicate(bad, "BUYER_FAVOR"),
    ]
    for make in calls:
        with respx.mock(assert_all_called=False) as router:
            with pytest.raises(PayPalError, match="dispute id"):
                run(make())
            assert len(router.calls) == 0


# ---- sandbox helpers ----


def test_require_evidence_and_adjudicate_bodies() -> None:
    with respx.mock() as router:
        token_ok(router)
        r1 = router.post(f"{D}/PP-D-1/require-evidence").mock(return_value=httpx.Response(202, json={}))
        r2 = router.post(f"{D}/PP-D-1/adjudicate").mock(return_value=httpx.Response(202, json={}))
        run(paypal.require_evidence("PP-D-1", "SELLER_EVIDENCE"))
        run(paypal.adjudicate("PP-D-1", "SELLER_FAVOR"))
    assert json.loads(r1.calls.last.request.content) == {"action": "SELLER_EVIDENCE"}
    assert json.loads(r2.calls.last.request.content) == {"adjudication_outcome": "SELLER_FAVOR"}


def test_sandbox_helpers_refuse_live_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.require_evidence("PP-D-1", "BUYER_EVIDENCE"))
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.adjudicate("PP-D-1", "BUYER_FAVOR"))
        assert len(router.calls) == 0


@pytest.mark.parametrize(
    "base",
    [
        "https://api-m.paypal.com/sandbox",
        "https://api-m.paypal.com?x=sandbox",
        "https://api-m.paypal.com#sandbox",
        "https://sandbox.example.com",
        "https://api-m.sandbox.paypal.com.evil.com",
        "https://evilsandbox.paypal.com",
        "https://sandbox.paypal.com.evil.com",
        "https://user@api-m.paypal.com/@sandbox",
        "http://api-m.sandbox.paypal.com",
        "ftp://api-m.sandbox.paypal.com",
        "api-m.sandbox.paypal.com",
    ],
)
def test_sandbox_helpers_refuse_bypass_bases(base: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", base)
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.require_evidence("PP-D-1", "BUYER_EVIDENCE"))
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.adjudicate("PP-D-1", "BUYER_FAVOR"))
        assert len(router.calls) == 0


@pytest.mark.parametrize("base", ["https://api.sandbox.paypal.com", "https://api-m.sandbox.paypal.com/"])
def test_sandbox_helpers_accept_sandbox_hosts(base: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", base)
    with respx.mock() as router:
        router.post(f"{base.rstrip('/')}/v1/oauth2/token").mock(
            return_value=httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        )
        route = router.post(f"{base.rstrip('/')}/v1/customer/disputes/PP-D-1/adjudicate").mock(
            return_value=httpx.Response(202, json={})
        )
        run(paypal.adjudicate("PP-D-1", "BUYER_FAVOR"))
    assert route.called


@pytest.mark.parametrize("fn,arg", [("require_evidence", "NOPE"), ("adjudicate", "NOPE")])
def test_sandbox_helpers_reject_unknown_values(fn: str, arg: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError):
            run(getattr(paypal, fn)("PP-D-1", arg))
        assert len(router.calls) == 0


# ---- list debug id ----


def test_list_disputes_page_exposes_debug_id_header() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(D).mock(return_value=httpx.Response(200, json={"items": []}, headers={"Paypal-Debug-Id": "dbg9"}))
        body, debug_id = run(paypal.list_disputes_page())
    assert body == {"items": []}
    assert debug_id == "dbg9"


def test_list_disputes_page_debug_id_none_without_header() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.get(D).mock(return_value=httpx.Response(200, json={}))
        assert run(paypal.list_disputes_page())[1] is None


# ---- accept_claim / make_offer ----

AMT = {"currency_code": "USD", "value": "12.50"}


def both(dispute_id: str, note: str, amount: dict[str, Any]) -> list[Callable[[], Coroutine[Any, Any, Any]]]:
    return [lambda: paypal.accept_claim(dispute_id, note, amount), lambda: paypal.make_offer(dispute_id, note, amount)]


def test_accept_claim_body_and_url() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-1/accept-claim").mock(return_value=httpx.Response(200, json={"links": []}))
        assert run(paypal.accept_claim("PP-D-1", "refund it")) == {"links": []}
    assert json.loads(route.calls.last.request.content) == {"note": "refund it", "accept_claim_type": "REFUND"}
    assert route.calls.last.request.headers["authorization"] == "Bearer tok"


def test_accept_claim_with_refund_amount() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-1/accept-claim").mock(return_value=httpx.Response(200, json={}))
        run(paypal.accept_claim("PP-D-1", "n", AMT))
    assert json.loads(route.calls.last.request.content) == {
        "note": "n",
        "accept_claim_type": "REFUND",
        "refund_amount": AMT,
    }


def test_make_offer_body_and_url() -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-1/make-offer").mock(return_value=httpx.Response(200, json={"ok": 1}))
        assert run(paypal.make_offer("PP-D-1", "half back", AMT)) == {"ok": 1}
    assert json.loads(route.calls.last.request.content) == {
        "note": "half back",
        "offer_amount": AMT,
        "offer_type": "REFUND",
    }


@pytest.mark.parametrize("kind", ["REFUND", "REFUND_WITH_RETURN", "REFUND_WITH_REPLACEMENT", "REPLACEMENT_WITHOUT_REFUND"])
def test_make_offer_types(kind: str) -> None:
    with respx.mock() as router:
        token_ok(router)
        route = router.post(f"{D}/PP-D-1/make-offer").mock(return_value=httpx.Response(200, json={}))
        run(paypal.make_offer("PP-D-1", "n", AMT, kind))
    assert json.loads(route.calls.last.request.content)["offer_type"] == kind


@pytest.mark.parametrize("bad", BAD_IDS)
def test_action_bad_ids_rejected_without_http(bad: str) -> None:
    for make in both(bad, "n", AMT):
        with respx.mock(assert_all_called=False) as router:
            with pytest.raises(PayPalError, match="dispute id"):
                run(make())
            assert len(router.calls) == 0


@pytest.mark.parametrize("note", ["", "   ", "x" * 2001])
def test_action_bad_note_rejected_without_http(note: str) -> None:
    for make in both("PP-D-1", note, AMT):
        with respx.mock(assert_all_called=False) as router:
            with pytest.raises(PayPalError, match="note"):
                run(make())
            assert len(router.calls) == 0


def test_action_note_at_limit_is_accepted() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.post(f"{D}/PP-D-1/accept-claim").mock(return_value=httpx.Response(200, json={}))
        run(paypal.accept_claim("PP-D-1", "x" * 2000))


@pytest.mark.parametrize(
    "amount",
    [
        {"currency_code": "USD", "value": "0"},
        {"currency_code": "USD", "value": "-1.00"},
        {"currency_code": "USD", "value": "abc"},
        {"currency_code": "USD", "value": "NaN"},
        {"currency_code": "USD", "value": "1e3"},
        {"currency_code": "USD", "value": 5},
        {"currency_code": "US", "value": "5"},
        {"currency_code": "usd", "value": "5"},
        {"value": "5"},
        {},
    ],
)
def test_action_bad_amount_rejected_without_http(amount: dict[str, Any]) -> None:
    for make in both("PP-D-1", "n", amount):
        with respx.mock(assert_all_called=False) as router:
            with pytest.raises(PayPalError, match="amount"):
                run(make())
            assert len(router.calls) == 0


def test_make_offer_rejects_unknown_offer_type() -> None:
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="offer_type"):
            run(paypal.make_offer("PP-D-1", "n", AMT, "NOPE"))
        assert len(router.calls) == 0


@pytest.mark.parametrize("suffix", ["accept-claim", "make-offer"])
def test_action_paypal_error_carries_debug_id(suffix: str) -> None:
    err = {"name": "ACTION_NOT_ALLOWED", "message": "no", "debug_id": "dbgA"}
    with respx.mock() as router:
        token_ok(router)
        router.post(f"{D}/PP-D-1/{suffix}").mock(return_value=httpx.Response(422, json=err))
        with pytest.raises(PayPalError) as ei:
            if suffix == "accept-claim":
                run(paypal.accept_claim("PP-D-1", "n"))
            else:
                run(paypal.make_offer("PP-D-1", "n", AMT))
    assert (ei.value.status, ei.value.name, ei.value.debug_id) == (422, "ACTION_NOT_ALLOWED", "dbgA")


@pytest.mark.parametrize("exc", [httpx.ReadTimeout("slow"), httpx.ConnectError("down")])
def test_transport_failure_on_the_request_is_ambiguous(exc: httpx.HTTPError) -> None:
    with respx.mock() as router:
        token_ok(router)
        router.post(f"{D}/PP-D-1/accept-claim").mock(side_effect=exc)
        with pytest.raises(PayPalError) as ei:
            run(paypal.accept_claim("PP-D-1", "n"))
    assert ei.value.ambiguous is True


def test_http_error_and_token_failure_are_not_ambiguous() -> None:
    with respx.mock() as router:
        token_ok(router)
        router.post(f"{D}/PP-D-1/accept-claim").mock(return_value=httpx.Response(500, json={}))
        with pytest.raises(PayPalError) as ei:
            run(paypal.accept_claim("PP-D-1", "n"))
    assert ei.value.ambiguous is False
    paypal._token = None
    with respx.mock() as router:
        router.post(TOKEN_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
        with pytest.raises(PayPalError) as ei2:
            run(paypal.accept_claim("PP-D-1", "n"))
    assert ei2.value.ambiguous is False


@pytest.mark.parametrize("suffix", ["accept-claim", "make-offer"])
def test_action_401_refreshes_token_and_retries(suffix: str) -> None:
    with respx.mock() as router:
        tok = router.post(TOKEN_URL).mock(
            side_effect=[
                httpx.Response(200, json={"access_token": "old", "expires_in": 3600}),
                httpx.Response(200, json={"access_token": "new", "expires_in": 3600}),
            ]
        )
        route = router.post(f"{D}/PP-D-1/{suffix}").mock(
            side_effect=[httpx.Response(401, json={"name": "AUTHENTICATION_FAILURE"}), httpx.Response(200, json={"ok": 1})]
        )
        if suffix == "accept-claim":
            assert run(paypal.accept_claim("PP-D-1", "n")) == {"ok": 1}
        else:
            assert run(paypal.make_offer("PP-D-1", "n", AMT)) == {"ok": 1}
    assert tok.call_count == 2
    assert [c.request.headers["authorization"] for c in route.calls] == ["Bearer old", "Bearer new"]


def test_actions_refuse_live_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.accept_claim("PP-D-1", "n"))
        with pytest.raises(PayPalError, match="sandbox"):
            run(paypal.make_offer("PP-D-1", "n", AMT))
        assert len(router.calls) == 0


# ---- live sandbox ----


def test_live_sandbox_list_page_has_debug_id(monkeypatch: pytest.MonkeyPatch) -> None:
    if not (REAL_ID and REAL_SECRET):
        pytest.fail("Needs fix: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env")
    monkeypatch.setenv("PAYPAL_CLIENT_ID", REAL_ID)
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", REAL_SECRET)
    body, debug_id = run(paypal.list_disputes_page(page_size=5))
    assert isinstance(body, dict)
    assert debug_id


def test_live_sandbox_list_show_and_error(monkeypatch: pytest.MonkeyPatch) -> None:
    if not (REAL_ID and REAL_SECRET):
        pytest.fail("Needs fix: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env")
    # the autouse fixture set fake creds; use the real ones captured at import
    monkeypatch.setenv("PAYPAL_CLIENT_ID", REAL_ID)
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", REAL_SECRET)

    async def go() -> tuple[dict[str, Any], dict[str, Any] | None, PayPalError]:
        listing = await paypal.list_disputes(page_size=5)
        items = listing.get("items") or []
        shown = await paypal.show_dispute(items[0]["dispute_id"]) if items else None
        try:
            await paypal.show_dispute("PP-D-0000000000")
        except PayPalError as e:
            return listing, shown, e
        raise AssertionError("expected PayPalError")

    listing, shown, err = run(go())
    assert isinstance(listing, dict)
    assert shown is None or "dispute_id" in shown
    assert err.status in (400, 404)
    assert err.debug_id
    assert err.debug_id in str(err)
