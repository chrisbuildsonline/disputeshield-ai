"""Autopilot: fetch, extract, score, then send the evidence on its own or flag the dispute for a person."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import paypal, scorecard, store
from app.extract import ExtractedEvidence
from app.scoring import score

router = APIRouter()


class Settings(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")  # strict: "50" and 50.5 are not a threshold
    enabled: bool
    threshold: int = Field(ge=0, le=100)


@router.get("/api/autopilot")
def get_settings() -> dict[str, Any]:
    return store.get_autopilot()


@router.put("/api/autopilot")
def put_settings(body: Settings) -> dict[str, Any]:
    store.set_autopilot(body.enabled, body.threshold)
    return store.get_autopilot()


def enabled() -> bool:
    return bool(store.get_autopilot()["enabled"])


def _flag(dispute_id: str, *reasons: str) -> None:
    store.add_audit(dispute_id, "autopilot_flagged", {"reasons": list(reasons)})


def _http_reason(e: HTTPException) -> str:
    d = e.detail
    return str(d.get("message")) if isinstance(d, dict) else str(d)


async def run(dispute_id: str) -> None:
    """Never raises: it runs in the background, where nobody would see the error."""
    try:
        await _run(dispute_id)
    except Exception as e:
        _flag(dispute_id, f"Autopilot error: {type(e).__name__}")


async def _run(dispute_id: str) -> None:
    # ponytail: lazy imports, submit and webhooks both start this agent
    from app.submit import _has_paypal_keys, send_evidence
    from app.webhooks import DisputeResource, dispute_row

    d = store.get_dispute(dispute_id)
    if d is None:
        return
    if (
        d["status"] in ("RESOLVED", "WAITING_FOR_BUYER_RESPONSE")  # the second means an offer is out
        or d["outcome"]
        or store.has_live_submission(dispute_id)
    ):
        store.add_audit(dispute_id, "autopilot_skipped", {"reason": "closed, already submitted or waiting for the buyer"})
        return
    settings = store.get_autopilot()
    store.add_audit(dispute_id, "autopilot_started", {"source": d["source"]})

    if d["source"] == "paypal" and _has_paypal_keys():  # ponytail: sync doesn't start the agent
        try:
            body = await paypal.show_dispute(dispute_id)
            store.upsert_dispute(dispute_row(DisputeResource.model_validate(body), body, "paypal"))
        except (paypal.PayPalError, ValueError) as e:
            _flag(dispute_id, str(e))
            return
        d = store.get_dispute(dispute_id) or d

    docs = store.list_documents(dispute_id, with_data=True)
    evs = [ExtractedEvidence.model_validate(x["evidence"]) for x in docs]
    merged = scorecard.merge(evs)
    fields = [k for k in ("carrier", "tracking_number", "delivered_at", "delivered_to", "signed_by", "order_id", "amount") if getattr(merged, k)]
    store.add_audit(dispute_id, "autopilot_evidence", {"documents": len(docs), "fields": fields})
    result = score(scorecard.to_dispute(d, scorecard.billing_of(d["resource"])), merged)
    store.add_audit(
        dispute_id, "autopilot_scored", {"probability": result.probability, "threshold": settings["threshold"]}
    )

    if not settings["enabled"]:
        _flag(dispute_id, "Autopilot is off")
    elif not docs:
        _flag(dispute_id, "No evidence documents")
    elif result.probability < settings["threshold"]:
        _flag(
            dispute_id,
            f"Win probability {result.probability}% is below the {settings['threshold']}% threshold",
            *[f.label for f in result.factors if not f.met],
        )
    else:
        try:
            sent = await send_evidence(dispute_id)
        except HTTPException as e:
            _flag(dispute_id, _http_reason(e))
        except (paypal.PayPalError, ValueError) as e:
            _flag(dispute_id, str(e))
        else:
            store.add_audit(
                dispute_id,
                "autopilot_submitted",
                {"probability": sent["probability"], "submission_id": sent["submission_id"], "status": sent["status"]},
            )
