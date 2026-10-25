"""Evidence documents, the submit flow, the audit log and sync from PayPal."""

import os
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError

from app import paypal, store
from app.dossier import _validate_files, build_dossier
from app.extract import MAX_PDF_BYTES, ExtractedEvidence, extract
from app.scoring import Dispute, Evidence, score
from app.webhooks import DisputeResource, dispute_row, read_body

DEMO_LABEL = "Demo mode: nothing was sent to PayPal"
PAYPAL_LABEL = "Sent to PayPal sandbox"
UNDER_REVIEW = "UNDER_REVIEW"  # PayPal's status once evidence is provided

router = APIRouter()


def _has_paypal_keys() -> bool:
    return bool(os.environ.get("PAYPAL_CLIENT_ID") and os.environ.get("PAYPAL_CLIENT_SECRET"))


def _use_claude() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


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
    data = await read_body(request, MAX_PDF_BYTES)
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "body is not a PDF")
    try:
        _validate_files([(name, data)])  # name rule, extension and size, same as the PayPal upload
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    evidence = await run_in_threadpool(extract, data, use_claude=_use_claude())
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


def _merge(evs: list[ExtractedEvidence]) -> Evidence:
    def pick(field: str) -> str | None:
        return next((v for e in evs if (v := getattr(e, field))), None)

    return Evidence(
        carrier=pick("carrier"),
        tracking_number=pick("tracking_number"),
        delivered_at=pick("delivered_at"),
        delivered_to=pick("delivered_to"),
        signed_by=pick("signed_by"),
        order_id=pick("order_id"),
        amount=pick("amount"),
        customer_messages=tuple(m for e in evs for m in e.customer_messages),
    )


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
        dispute = Dispute(reason=d["reason"] or "other", amount=d["amount_value"] or "")
        result = score(dispute, _merge(evs))
        dossier = await run_in_threadpool(
            build_dossier, dispute, evs, result, [(x["name"], x["data"]) for x in docs], use_claude=_use_claude()
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
