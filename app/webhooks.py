import json
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import Headers

from app import paypal, store

MAX_BODY = 1024 * 1024
DISPUTE_EVENTS = {
    "CUSTOMER.DISPUTE.CREATED",
    "CUSTOMER.DISPUTE.UPDATED",
    "CUSTOMER.DISPUTE.RESOLVED",
}
SIGNATURE_HEADERS = {
    "auth_algo": "paypal-auth-algo",
    "cert_url": "paypal-cert-url",
    "transmission_id": "paypal-transmission-id",
    "transmission_sig": "paypal-transmission-sig",
    "transmission_time": "paypal-transmission-time",
}

router = APIRouter()


class Amount(BaseModel):
    model_config = ConfigDict(extra="allow")
    currency_code: str
    value: str


class DisputeResource(BaseModel):
    model_config = ConfigDict(extra="allow")
    dispute_id: str = Field(min_length=1)
    reason: str | None = None
    status: str | None = None
    dispute_amount: Amount | None = None
    create_time: str | None = None
    update_time: str | None = None
    seller_response_due_date: str | None = None
    dispute_life_cycle_stage: str | None = None
    dispute_outcome: dict[str, Any] | None = None


class WebhookEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    resource: dict[str, Any]


def parse_event(data: Any) -> tuple[WebhookEvent, DisputeResource | None]:
    event = WebhookEvent.model_validate(data)
    if event.event_type not in DISPUTE_EVENTS:
        return event, None
    return event, DisputeResource.model_validate(event.resource)


def dispute_row(res: DisputeResource, raw: dict[str, Any], source: str) -> dict[str, Any]:
    outcome = (res.dispute_outcome or {}).get("outcome_code")
    return {
        "id": res.dispute_id,
        "reason": res.reason,
        "status": res.status,
        "amount_value": res.dispute_amount.value if res.dispute_amount else None,
        "currency": res.dispute_amount.currency_code if res.dispute_amount else None,
        "create_time": res.create_time,
        "update_time": res.update_time,
        "seller_response_due_date": res.seller_response_due_date,
        "outcome": outcome if isinstance(outcome, str) else None,
        "resource": json.dumps(raw),
        "source": source,
    }


async def _verify_signature(headers: Headers, event: dict[str, Any], webhook_id: str) -> None:
    sig = {key: headers.get(name) for key, name in SIGNATURE_HEADERS.items()}
    if any(v is None for v in sig.values()):
        raise HTTPException(401, "missing PayPal signature headers")
    payload = {**sig, "webhook_id": webhook_id, "webhook_event": event}
    try:
        token = await paypal.get_token()
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"{paypal.api_base()}/v1/notifications/verify-webhook-signature",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code >= 500:
            raise paypal.PayPalError(f"verify failed: {r.status_code}")
        status = r.json().get("verification_status") if r.status_code == 200 else None
    except (httpx.HTTPError, paypal.PayPalError, ValueError, AttributeError) as e:
        raise HTTPException(503, "could not verify signature with PayPal") from e
    if status != "SUCCESS":
        raise HTTPException(401, "invalid PayPal signature")


async def read_body(request: Request, limit: int) -> bytes:
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > limit:
        raise HTTPException(413, "body too large")
    chunks = bytearray()
    async for chunk in request.stream():
        chunks += chunk
        if len(chunks) > limit:
            raise HTTPException(413, "body too large")
    return bytes(chunks)


@router.post("/api/webhooks/paypal")
async def paypal_webhook(request: Request) -> dict[str, Any]:
    body = await read_body(request, MAX_BODY)
    try:
        data = json.loads(body)
        json.dumps(data, ensure_ascii=False).encode()
    except (ValueError, RecursionError):
        raise HTTPException(422, "body is not valid JSON") from None
    try:
        event, dispute = parse_event(data)
    except ValidationError as e:
        raise HTTPException(
            422, e.errors(include_url=False, include_context=False, include_input=False)
        ) from None
    if dispute is None:
        return {"ignored": True}

    webhook_id = os.environ.get("PAYPAL_WEBHOOK_ID")
    if webhook_id:
        await _verify_signature(request.headers, data, webhook_id)
    elif os.environ.get("DISPUTESHIELD_DEMO_MODE") != "1":
        raise HTTPException(503, "webhook verification not configured")
    result = store.record_event(
        event.id,
        event.event_type,
        dispute_row(dispute, event.resource, "paypal" if webhook_id else "simulated"),
    )
    if result == "duplicate":
        return {"duplicate": True}
    return {
        "ok": True,
        "dispute_id": dispute.dispute_id,
        "verified": bool(webhook_id),
        "mode": "verified" if webhook_id else "demo",
    }


@router.get("/api/disputes")
def list_disputes() -> list[dict[str, Any]]:
    return store.list_disputes()


@router.get("/api/disputes/{dispute_id}")
def get_dispute(dispute_id: str) -> dict[str, Any]:
    dispute = store.get_dispute(dispute_id)
    if dispute is None:
        raise HTTPException(404, "dispute not found")
    return dispute
