"""Turn a stored dispute and its extracted documents into a score. No Claude, no network."""

from typing import Any

from app.extract import ExtractedEvidence
from app.scoring import Dispute, Evidence, ScoreResult, score

BILLING_KEY = "buyer_billing_address"  # set on simulated disputes; real PayPal disputes don't carry one


def merge(evs: list[ExtractedEvidence]) -> Evidence:
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


def to_dispute(row: dict[str, Any], billing_address: str | None) -> Dispute:
    return Dispute(
        reason=row["reason"] or "other", amount=row["amount_value"] or "", billing_address=billing_address
    )


def score_dispute(row: dict[str, Any], billing_address: str | None, evs: list[ExtractedEvidence]) -> ScoreResult:
    return score(to_dispute(row, billing_address), merge(evs))


def billing_of(resource: dict[str, Any]) -> str | None:
    value = resource.get(BILLING_KEY)
    return value if isinstance(value, str) else None
