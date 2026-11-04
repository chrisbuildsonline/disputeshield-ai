"""Evidence documents, the submit flow, the audit log and sync from PayPal."""

import asyncio
import os
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, ValidationError

from app import auth, autopilot, demo, llm, paypal, scorecard, store
from app.dossier import _validate_files, build_dossier
from app.extract import MAX_PDF_BYTES, ExtractedEvidence, extract
from app.scoring import ACCEPT_BELOW, FIGHT_AT, recommend, score
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
    dispute_id: str, request: Request, background: BackgroundTasks, name: str = Query(max_length=255)
) -> dict[str, Any]:
    _require_dispute(dispute_id)
    stored = await _store_document(dispute_id, name, await read_body(request, MAX_PDF_BYTES))
    if not store.has_live_submission(dispute_id):
        # new evidence may clear an earlier flag; with autopilot off the rerun only scores and flags, it never sends
        background.add_task(autopilot.run, dispute_id)
    return stored


async def _store_document(dispute_id: str, name: str, data: bytes, *, use_llm: bool | None = None) -> dict[str, Any]:
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "body is not a PDF")
    try:
        _validate_files([(name, data)])  # name rule, extension and size, same as the PayPal upload
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    evidence = await run_in_threadpool(extract, data, use_llm=_use_llm() if use_llm is None else use_llm)
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


_PREVIEWS: dict[tuple[Any, ...], dict[str, Any]] = {}  # dossier previews, see dossier_preview


def _order_record(dispute_id: str) -> str | None:
    """The dossier line for a real recorded PayPal invoice; the demo fixture is not evidence of anything."""
    for a in store.list_audit(dispute_id):
        d = a["detail"]
        if a["action"] == store.INVOICE_ACTION and d.get("mode") == "paypal":
            return f"Order record: PayPal invoice {d['invoice_id']} ({str(d['status']).lower()}, created {a['at'][:10]})."
    return None


def _scored(dispute_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], Any, Any, list[ExtractedEvidence]]:
    d = _require_dispute(dispute_id)
    docs = store.list_documents(dispute_id, with_data=True)
    evs = [ExtractedEvidence.model_validate(x["evidence"]) for x in docs]
    dispute = scorecard.to_dispute(d, scorecard.billing_of(d["resource"]))
    return d, docs, dispute, score(dispute, scorecard.merge(evs)), evs


@router.get("/api/disputes/{dispute_id}/dossier")
async def dossier_preview(dispute_id: str) -> dict[str, Any]:
    """The dossier the submit would send. The note may cost a model call, so it lives apart from the score.

    Only the detail panel asks (never the grid's poll), and the answer is cached per dispute + document set:
    same documents, same note, no second call.
    """
    d, docs, dispute, result, evs = _scored(dispute_id)
    order_record = _order_record(dispute_id)
    key = (
        dispute_id, d["reason"], d["amount_value"], tuple((x["name"], x["created_at"]) for x in docs), llm.provider(),
        order_record,
    )
    preview = _PREVIEWS.get(key)
    if preview is None:
        await asyncio.sleep(float(os.environ.get("DISPUTESHIELD_NOTE_DELAY") or 0))  # test hook: a slow model, off unless set
        try:
            dossier = await run_in_threadpool(
                build_dossier, dispute, evs, result, [(x["name"], x["data"]) for x in docs],
                use_llm=_use_llm(), order_record=order_record,
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
    return preview


@router.get("/api/disputes/{dispute_id}/score")
async def score_preview(dispute_id: str) -> dict[str, Any]:
    """Score breakdown: deterministic and fast, never a model call (the note is at /dossier)."""
    _, docs, _, result, _ = _scored(dispute_id)
    points = [f.weight if f.met else 0 for f in result.factors]
    action, reason = recommend(result.probability)
    return {
        "recommendation": {"action": action, "reason": reason, "fight_at": FIGHT_AT, "accept_below": ACCEPT_BELOW},
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
    }


async def _create_demo(s: demo.Scenario, background: BackgroundTasks, *, use_llm: bool) -> dict[str, Any]:
    resource = demo.resource(s)
    res = DisputeResource.model_validate(resource)
    store.record_event(
        f"DEMO-{uuid4().hex}", "CUSTOMER.DISPUTE.CREATED", dispute_row(res, resource, "simulated")
    )
    store.add_audit(res.dispute_id, "simulated_chargeback", {"reason": res.reason})
    for name in s.docs:
        await _store_document(res.dispute_id, name, (SAMPLES / name).read_bytes(), use_llm=use_llm)
    background.add_task(autopilot.run, res.dispute_id)  # always, so an "off" autopilot shows its flag in the demo
    return _require_dispute(res.dispute_id)


def _require_demo_mode() -> None:
    if os.environ.get("DISPUTESHIELD_DEMO_MODE") != "1":
        raise HTTPException(404, "not found")


@router.post("/api/demo/chargeback")
async def demo_chargeback(background: BackgroundTasks) -> dict[str, Any]:
    _require_demo_mode()
    return await _create_demo(demo.SCENARIOS[0], background, use_llm=_use_llm())


@router.post("/api/demo/seed")
async def demo_seed(background: BackgroundTasks) -> dict[str, Any]:
    """Five varied simulated chargebacks. Receipts are read with the regex parser: the sample PDFs are fixed, so no model call."""
    _require_demo_mode()
    disputes = [await _create_demo(s, background, use_llm=False) for s in demo.SCENARIOS]
    return {"count": len(disputes), "disputes": disputes}


@router.post("/api/disputes/{dispute_id}/submit")
async def submit(dispute_id: str) -> dict[str, Any]:
    return await send_evidence(dispute_id)


async def send_evidence(dispute_id: str) -> dict[str, Any]:
    """The submit route's body, also called by the autopilot. Raises HTTPException."""
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
            build_dossier, dispute, evs, result, [(x["name"], x["data"]) for x in docs],
            use_llm=_use_llm(), order_record=_order_record(dispute_id),
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


NO_KEYS = "PayPal keys are not set: add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env"


@router.post("/api/paypal/sync")
@router.post("/api/disputes/sync")  # alias kept for the README and the smoke script
async def sync() -> dict[str, Any]:
    if not _has_paypal_keys():
        raise HTTPException(409, NO_KEYS)
    out: list[dict[str, str]] = []
    try:
        # ponytail: first page of the list only
        listing, debug_id = await paypal.list_disputes_page()
        fetched_at = datetime.now(UTC).isoformat()
        for item in listing.get("items") or []:
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
    return {
        "count": len(out),
        "fetched_at": fetched_at,
        "debug_id": debug_id,
        "mode": "sandbox" if paypal.is_sandbox() else "live",
        "disputes": out,
    }


# ---- second PayPal API family: record the order as an invoice (Invoicing API) ----

INVOICE_LABEL = "Recorded on PayPal sandbox"


def _invoice_response(rec: dict[str, Any], *, already: bool) -> dict[str, Any]:
    demo_mode = rec["mode"] == "demo"
    return {
        "mode": rec["mode"],
        "demo": demo_mode,
        "source": rec["source"],
        "label": DEMO_LABEL if demo_mode else INVOICE_LABEL,
        "simulated_case": bool(rec.get("simulated_case")),
        "status": rec["status"],
        "invoice_id": rec["invoice_id"],
        "invoice_number": rec["invoice_number"],
        "debug_id": rec["debug_id"],
        "lookup_debug_id": rec["lookup_debug_id"],
        "fields": {
            k: rec[k]
            for k in ("invoice_id", "invoice_number", "status", "total", "item", "recipient", "verified")
        },
        "already_recorded": already,
    }


@router.post("/api/disputes/{dispute_id}/paypal-invoice")
async def paypal_invoice(dispute_id: str) -> dict[str, Any]:
    """Record the disputed order as a PayPal invoice. A real (sandbox) draft is listed in the dossier note; it never moves the score.

    Live (a PayPal dispute with keys, or a simulated one with demo mode off, keys and the sandbox base): creates a
    draft invoice in the sandbox and reads it back. Any other simulated dispute gets a fixed fixture labelled "demo". The first result is kept; asking again returns it.
    """
    d = _require_dispute(dispute_id)
    stored = store.invoice_records().get(dispute_id)
    if stored is not None:
        return _invoice_response(stored, already=True)
    if d["source"] == "paypal" and not _has_paypal_keys():
        raise HTTPException(409, NO_KEYS)
    docs = store.list_documents(dispute_id)
    evs = [ExtractedEvidence.model_validate(x["evidence"]) for x in docs]
    order_id = scorecard.merge(evs).order_id
    item = f"Order {order_id}" if order_id else f"Disputed order for case {dispute_id}"
    total = {"currency_code": str(d["currency"] or "USD"), "value": str(d["amount_value"] or "").strip()}
    try:
        paypal.check_amount(total)
    except paypal.PayPalError as e:
        raise HTTPException(422, f"can't invoice this dispute: {e}") from None
    buyer = d["resource"].get("buyer")
    recipient = buyer.get("name") if isinstance(buyer, dict) and isinstance(buyer.get("name"), str) else None
    # Invoicing needs no buyer, so a simulated case can still make a real sandbox call. Never with demo mode on,
    # without keys, or against a non-sandbox base: those keep the fixture.
    simulated_live = d["source"] != "paypal" and not auth.demo_mode() and _has_paypal_keys() and paypal.is_sandbox()
    mode = "paypal" if d["source"] == "paypal" or simulated_live else "demo"
    if mode == "demo":
        rec = demo.invoice_fixture(dispute_id, item, total, recipient)
    else:
        try:
            rec = await paypal.record_invoice(item, total, recipient_name=recipient, note=item)
        except paypal.PayPalError as e:
            store.add_audit(dispute_id, "invoice_failed", {"error": str(e), "debug_id": e.debug_id})
            raise HTTPException(
                502, {"message": str(e), "paypal_name": e.name, "debug_id": e.debug_id}
            ) from None
    rec = {**rec, "mode": mode, "source": "live sandbox" if mode == "paypal" else "demo",
           "simulated_case": simulated_live}
    # ponytail: two clicks at once could create two sandbox drafts; the first audit row wins
    store.add_audit(dispute_id, store.INVOICE_ACTION, rec)
    return _invoice_response(rec, already=False)


# ---- low-odds actions: accept the claim or offer a refund ----

ACCEPT_NOTE = "The seller accepts the claim and will refund the buyer."


class AcceptBody(BaseModel):
    note: str | None = Field(None, max_length=paypal.MAX_NOTE)


class OfferBody(BaseModel):
    amount: str
    note: str = Field(min_length=1, max_length=paypal.MAX_NOTE)


@router.post("/api/disputes/{dispute_id}/accept")
async def accept(dispute_id: str, body: AcceptBody | None = None) -> dict[str, Any]:
    note = (body.note if body else None) or ACCEPT_NOTE
    return await _act(dispute_id, "accept", note, None)


@router.post("/api/disputes/{dispute_id}/offer")
async def offer(dispute_id: str, body: OfferBody) -> dict[str, Any]:
    return await _act(dispute_id, "offer", body.note, body.amount)


def _offer_pending(dispute_id: str) -> bool:
    """True if the latest 'offered' audit row has no later accept or evidence submission."""
    for a in reversed(store.list_audit(dispute_id)):
        if a["action"] in ("accepted", "submitted"):
            return False
        if a["action"] == "offered":
            return True
    return False


async def _act(dispute_id: str, action: str, note: str, value: str | None) -> dict[str, Any]:
    d = _require_dispute(dispute_id)
    note = note.strip()
    if not note:
        if action == "offer":
            raise HTTPException(422, "an offer needs a note for the buyer")
        note = ACCEPT_NOTE
    amount: dict[str, str] | None = None
    if value is not None:
        amount = {"currency_code": str(d["currency"] or "USD"), "value": value.strip()}
        try:
            paypal.check_amount(amount)
        except paypal.PayPalError as e:
            raise HTTPException(422, str(e)) from None
        try:
            too_much = Decimal(amount["value"]) > Decimal(str(d["amount_value"]))
        except InvalidOperation:  # no usable disputed amount stored: nothing to compare against
            too_much = False
        if too_much:
            raise HTTPException(422, f"offer can't be more than the disputed {d['amount_value']} {amount['currency_code']}")
    if d["status"] == "RESOLVED" or d["outcome"]:
        _refuse(dispute_id, 409, "dispute is closed")
    if action == "offer" and (d["status"] == "WAITING_FOR_BUYER_RESPONSE" or _offer_pending(dispute_id)):
        _refuse(dispute_id, 409, "an offer is already waiting for the buyer")
    if d["source"] == "paypal" and not _has_paypal_keys():
        raise HTTPException(409, NO_KEYS)  # a PayPal dispute is never settled by a demo act
    mode = "paypal" if d["source"] == "paypal" else "demo"
    sid = store.claim_submission(dispute_id, f"{action}:{mode}")  # shares the evidence claim: one act per dispute
    if sid is None:
        _refuse(dispute_id, 409, "already submitted or acted on")
    done = "accepted" if action == "accept" else "offered"
    status = "RESOLVED" if action == "accept" else "WAITING_FOR_BUYER_RESPONSE"
    response: dict[str, Any] | None = None
    reconciled = False
    verified = True
    try:
        if mode == "paypal":
            try:
                if action == "accept":
                    response = await paypal.accept_claim(dispute_id, note)
                else:
                    assert amount is not None
                    response = await paypal.make_offer(dispute_id, note, amount)
            except paypal.PayPalError as e:
                if not e.ambiguous:
                    raise
                # The request may have reached PayPal: releasing the claim could double-refund, so look first.
                try:
                    seen = str((await paypal.show_dispute(dispute_id)).get("status") or "")
                except paypal.PayPalError:
                    store.finish_submission(sid, "submitted", error=str(e))  # keep the claim
                    store.add_audit(dispute_id, f"{action}_unconfirmed", {"error": str(e), "debug_id": e.debug_id})
                    raise HTTPException(
                        502,
                        {
                            "message": f"{e}. PayPal may have received it and the status check failed too: "
                            "run Sync from PayPal to confirm before trying again.",
                            "paypal_name": e.name,
                            "debug_id": e.debug_id,
                        },
                    ) from None
                if not seen or seen == d["status"]:
                    raise
                status, reconciled = seen, True
            else:
                try:
                    status = str((await paypal.show_dispute(dispute_id)).get("status") or status)
                except paypal.PayPalError:  # the action is done; keep the expected status and say it is unconfirmed
                    verified = False
    except HTTPException:
        raise
    except paypal.PayPalError as e:
        store.finish_submission(sid, "failed", error=str(e))
        store.add_audit(dispute_id, f"{action}_failed", {"error": str(e), "debug_id": e.debug_id})
        raise HTTPException(
            502, {"message": str(e), "paypal_name": e.name, "debug_id": e.debug_id}
        ) from None
    except BaseException as e:
        store.finish_submission(sid, "failed", error=f"{type(e).__name__}: {e}")
        store.add_audit(dispute_id, f"{action}_failed", {"error": type(e).__name__})
        raise
    # "offered" is outside the live index: the buyer may refuse, and then the seller can still accept or send evidence
    store.finish_submission(sid, "offered" if action == "offer" else "submitted", response=response)
    store.set_status(dispute_id, status)
    store.add_audit(
        dispute_id,
        done,
        {
            "mode": mode,
            "status": status,
            "amount": amount,
            "note": note,
            "status_verified": verified,
            "reconciled": reconciled,
        },
    )
    return {
        "mode": mode,
        "demo": mode == "demo",
        "label": DEMO_LABEL if mode == "demo" else PAYPAL_LABEL,
        "action": action,
        "status": status,
        "paypal_response": response,
    }
