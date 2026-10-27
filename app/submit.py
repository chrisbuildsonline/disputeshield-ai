"""Evidence documents, the submit flow, the audit log and sync from PayPal."""

import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError

from app import llm, paypal, scorecard, store
from app.dossier import _validate_files, build_dossier
from app.extract import MAX_PDF_BYTES, ExtractedEvidence, extract
from app.scoring import INR, score
from app.webhooks import DisputeResource, dispute_row, read_body

SAMPLES = Path(__file__).parent.parent / "samples"

DEMO_LABEL = "Demo mode: nothing was sent to PayPal"
PAYPAL_LABEL = "Sent to PayPal sandbox"
UNDER_REVIEW = "UNDER_REVIEW"  # PayPal's status once evidence is provided

router = APIRouter()


def _has_paypal_keys() -> bool:
    return bool(os.environ.get("PAYPAL_CLIENT_ID") and os.environ.get("PAYPAL_CLIENT_SECRET"))


def _use_llm() -> bool:
    return llm.provider() != "off"


def _require_dispute(dispute_id: str) -> dict[str, Any]:
    dispute = store.get_dispute(dispute_id)
    if dispute is None:
        raise HTTPException(404, "dispute not found")
    return dispute


def _refuse(dispute_id: str, code: int, reason: str) -> NoReturn:
    store.add_audit(dispute_id, "submit_refused", {"reason": reason})
    raise HTTPException(code, reason)


@router.post("/api/disputes/{dispute_id}/documents")
async def add_document(
    dispute_id: str, request: Request, name: str = Query(max_length=255)
) -> dict[str, Any]:
    _require_dispute(dispute_id)
    return await _store_document(dispute_id, name, await read_body(request, MAX_PDF_BYTES))


async def _store_document(dispute_id: str, name: str, data: bytes) -> dict[str, Any]:
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "body is not a PDF")
    try:
        _validate_files([(name, data)])  # name rule, extension and size, same as the PayPal upload
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    evidence = await run_in_threadpool(extract, data, use_llm=_use_llm())
    store.add_document(dispute_id, name, data, evidence.model_dump())
    store.add_audit(dispute_id, "document_added", {"name": name, "size": len(data)})
    return {"ok": True, "name": name, "size": len(data), "evidence": evidence.model_dump()}


@router.get("/api/disputes/{dispute_id}/documents")
def list_documents(dispute_id: str) -> list[dict[str, Any]]:
    _require_dispute(dispute_id)
    return store.list_documents(dispute_id)


@router.get("/api/disputes/{dispute_id}/audit")
def audit(dispute_id: str) -> list[dict[str, Any]]:
    _require_dispute(dispute_id)
    return store.list_audit(dispute_id)


_PREVIEWS: dict[tuple[Any, ...], dict[str, Any]] = {}  # dossier previews, see score_preview


@router.get("/api/disputes/{dispute_id}/score")
async def score_preview(dispute_id: str) -> dict[str, Any]:
    """Score breakdown plus the dossier the submit would send.

    The note may cost a model call, so the preview is only built here (the detail panel opening, never the
    grid's poll) and is cached per dispute + document set: same documents, same note, no second call.
    """
    d = _require_dispute(dispute_id)
    docs = store.list_documents(dispute_id, with_data=True)
    evs = [ExtractedEvidence.model_validate(x["evidence"]) for x in docs]
    dispute = scorecard.to_dispute(d, scorecard.billing_of(d["resource"]))
    result = score(dispute, scorecard.merge(evs))
    key = (dispute_id, d["reason"], d["amount_value"], tuple((x["name"], x["created_at"]) for x in docs), llm.provider())
    preview = _PREVIEWS.get(key)
    if preview is None:
        try:
            dossier = await run_in_threadpool(
                build_dossier, dispute, evs, result, [(x["name"], x["data"]) for x in docs], use_llm=_use_llm()
            )
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        preview = {
            "note": dossier.input["evidences"][0]["notes"],
            "note_source": dossier.note_source,
            "note_model": dossier.note_model,
            "files": [n for n, _ in dossier.files],
        }
        if len(_PREVIEWS) >= 256:
            _PREVIEWS.clear()
        _PREVIEWS[key] = preview
    points = [f.weight if f.met else 0 for f in result.factors]
    return {
        "dispute_id": dispute_id,
        "probability": result.probability,
        "base": result.probability - sum(points),
        "factors": [
            {
                "label": f.label,
                "weight": f.weight,
                "met": f.met,
                "points": p,
                "reason": "Found in the uploaded evidence" if f.met else "Not found in the uploaded evidence",
            }
            for f, p in zip(result.factors, points, strict=True)
        ],
        "documents": [{"name": x["name"], "size": x["size"], "evidence": x["evidence"]} for x in docs],
        "dossier": preview,
    }


def _demo_dispute() -> dict[str, Any]:
    """A simulated 'item not received' chargeback shaped like PayPal's CUSTOMER.DISPUTE.CREATED resource."""
    now = datetime.now(UTC)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {
        "dispute_id": f"PP-D-{uuid4().hex[:10].upper()}",
        "reason": INR,
        "status": "OPEN",
        "dispute_amount": {"currency_code": "USD", "value": "49.90"},
        "create_time": stamp,
        "update_time": stamp,
        "seller_response_due_date": (now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "dispute_channel": "INTERNAL",
        "messages": [{"posted_by": "BUYER", "time_posted": stamp, "content": "item not received"}],
        scorecard.BILLING_KEY: "12 High Street, Leeds LS1 4AB",  # the address on the sample UPS receipt
    }


@router.post("/api/demo/chargeback")
async def demo_chargeback() -> dict[str, Any]:
    if os.environ.get("DISPUTESHIELD_DEMO_MODE") != "1":
        raise HTTPException(404, "not found")
    resource = _demo_dispute()
    res = DisputeResource.model_validate(resource)
    store.record_event(
        f"DEMO-{uuid4().hex}", "CUSTOMER.DISPUTE.CREATED", dispute_row(res, resource, "simulated")
    )
    store.add_audit(res.dispute_id, "simulated_chargeback", {"reason": res.reason})
    receipt = SAMPLES / "ups_receipt.pdf"
    await _store_document(res.dispute_id, receipt.name, receipt.read_bytes())
    return _require_dispute(res.dispute_id)


@router.post("/api/disputes/{dispute_id}/submit")
async def submit(dispute_id: str) -> dict[str, Any]:
    d = _require_dispute(dispute_id)
    if d["status"] == "RESOLVED" or d["outcome"]:
        _refuse(dispute_id, 409, "dispute is closed")
    docs = store.list_documents(dispute_id, with_data=True)
    if not docs:
        _refuse(dispute_id, 422, "no documents uploaded")
    mode = "paypal" if d["source"] == "paypal" and _has_paypal_keys() else "demo"
    sid = store.claim_submission(dispute_id, mode)  # before any network call
    if sid is None:
        _refuse(dispute_id, 409, "already submitted")
    dossier_input: dict[str, Any] | None = None
    try:
        evs = [ExtractedEvidence.model_validate(x["evidence"]) for x in docs]
        dispute = scorecard.to_dispute(d, scorecard.billing_of(d["resource"]))
        result = score(dispute, scorecard.merge(evs))
        dossier = await run_in_threadpool(
            build_dossier, dispute, evs, result, [(x["name"], x["data"]) for x in docs], use_llm=_use_llm()
        )
        dossier_input = dossier.input
        status, response = UNDER_REVIEW, None
        if mode == "paypal":
            response = await paypal.provide_evidence(dispute_id, dossier)
            try:
                status = str((await paypal.show_dispute(dispute_id)).get("status") or UNDER_REVIEW)
            except paypal.PayPalError:  # ponytail: the evidence is already sent, so don't fail (and allow a re-send)
                pass
    except paypal.PayPalError as e:
        store.finish_submission(sid, "failed", input=dossier_input, error=str(e))
        store.add_audit(dispute_id, "submit_failed", {"error": str(e), "debug_id": e.debug_id})
        raise HTTPException(
            502, {"message": str(e), "paypal_name": e.name, "debug_id": e.debug_id}
        ) from None
    except ValueError as e:  # bad attachments
        store.finish_submission(sid, "failed", input=dossier_input, error=str(e))
        store.add_audit(dispute_id, "submit_failed", {"error": str(e)})
        raise HTTPException(422, str(e)) from None
    except BaseException as e:
        store.finish_submission(sid, "failed", input=dossier_input, error=f"{type(e).__name__}: {e}")
        store.add_audit(dispute_id, "submit_failed", {"error": type(e).__name__})
        raise
    store.finish_submission(sid, "submitted", input=dossier_input, response=response)
    store.set_status(dispute_id, status)
    store.add_audit(
        dispute_id,
        "submitted",
        {"mode": mode, "submission_id": sid, "status": status, "probability": result.probability},
    )
    return {
        "mode": mode,
        "demo": mode == "demo",
        "label": DEMO_LABEL if mode == "demo" else PAYPAL_LABEL,
        "status": status,
        "submission_id": sid,
        "probability": result.probability,
        "note_source": dossier.note_source,
        "paypal_response": response,
    }


@router.post("/api/disputes/sync")
async def sync() -> list[dict[str, str]]:
    if not _has_paypal_keys():
        raise HTTPException(409, "PayPal keys not set")
    out: list[dict[str, str]] = []
    try:
        # ponytail: first page of the list only
        for item in (await paypal.list_disputes()).get("items") or []:
            body = await paypal.show_dispute(str(item["dispute_id"]))
            try:
                res = DisputeResource.model_validate(body)
            except ValidationError:
                continue
            result = store.upsert_dispute(dispute_row(res, body, "paypal"))
            store.add_audit(res.dispute_id, "synced", {"result": result})
            out.append({"dispute_id": res.dispute_id, "result": result})
    except paypal.PayPalError as e:
        raise HTTPException(
            502, {"message": str(e), "paypal_name": e.name, "debug_id": e.debug_id}
        ) from None
    return out
