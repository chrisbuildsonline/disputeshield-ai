"""Deterministic win-probability scorer. Pure: stdlib only, no I/O.

probability = clamp(base + sum(weight of met factors), 0, 100). All weights are
positive, so making one more factor true can never lower the score.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

INR = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
UNAUTHORISED = "UNAUTHORISED"
SNAD = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"


@dataclass(frozen=True)
class Dispute:
    reason: str
    amount: Decimal | str
    billing_address: str | None = None
    currency: str | None = None


@dataclass(frozen=True)
class Evidence:
    carrier: str | None = None
    tracking_number: str | None = None
    delivered_at: str | datetime | None = None
    delivered_to: str | None = None
    signed_by: str | None = None
    order_id: str | None = None
    amount: Decimal | str | None = None
    customer_messages: tuple[str, ...] = field(default_factory=tuple)
    avs_match: bool | None = None
    cvv_match: bool | None = None
    prior_orders_from_buyer: int | None = None
    item_description_matches: bool | None = None
    refund_offered: bool | None = None


@dataclass(frozen=True)
class Factor:
    label: str
    weight: int
    met: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ScoreResult:
    probability: int
    factors: list[Factor]

    def to_dict(self) -> dict[str, Any]:
        return {"probability": self.probability, "factors": [f.to_dict() for f in self.factors]}


def _present(value: object) -> bool:
    if isinstance(value, datetime):
        return True
    return isinstance(value, str) and bool(value.strip())


def _norm_address(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"[\W_]+", " ", value.casefold()).split())


def _to_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, Decimal | str):
        return None
    try:
        d = Decimal(value.strip()) if isinstance(value, str) else value
        return d if d.is_finite() else None
    except InvalidOperation:
        return None


Check = Callable[[Dispute, Evidence], bool]


def _delivered(_: Dispute, e: Evidence) -> bool:
    return _present(e.delivered_at)


def _shipped(_: Dispute, e: Evidence) -> bool:
    return _present(e.carrier) and _present(e.tracking_number)


def _address(d: Dispute, e: Evidence) -> bool:
    billing = _norm_address(d.billing_address)
    return billing != "" and billing == _norm_address(e.delivered_to)


def _signed(_: Dispute, e: Evidence) -> bool:
    return _present(e.signed_by)


def _order(_: Dispute, e: Evidence) -> bool:
    return _present(e.order_id)


def _amount(d: Dispute, e: Evidence) -> bool:
    a, b = _to_decimal(d.amount), _to_decimal(e.amount)
    return a is not None and b is not None and a == b


def _messages(_: Dispute, e: Evidence) -> bool:
    return any(_present(m) for m in e.customer_messages)


def _tracking(_: Dispute, e: Evidence) -> bool:
    return _present(e.tracking_number)


def _avs(_: Dispute, e: Evidence) -> bool:
    return e.avs_match is True


def _cvv(_: Dispute, e: Evidence) -> bool:
    return e.cvv_match is True


def _prior(_: Dispute, e: Evidence) -> bool:
    return e.prior_orders_from_buyer is not None and e.prior_orders_from_buyer > 0


def _item(_: Dispute, e: Evidence) -> bool:
    return e.item_description_matches is True


def _refund(_: Dispute, e: Evidence) -> bool:
    return e.refund_offered is True


# (base, [(label, weight, check)]). Base + all weights = 100 for every set.
_RULES: dict[str, tuple[int, list[tuple[str, int, Check]]]] = {
    INR: (
        9,
        [
            ("Carrier and tracking number provided", 15, _shipped),
            ("Delivery confirmed by carrier", 20, _delivered),
            ("Delivered to the billing address", 25, _address),
            ("Signature on delivery", 15, _signed),
            ("Order amount matches the dispute", 10, _amount),
            ("Order ID on file", 6, _order),
        ],
    ),
    UNAUTHORISED: (
        5,
        [
            ("Address verification (AVS) matched", 15, _avs),
            ("Card security code (CVV) matched", 15, _cvv),
            ("Buyer has previous orders", 15, _prior),
            ("Delivered to the billing address", 20, _address),
            ("Delivery confirmed by carrier", 15, _delivered),
            ("Signature on delivery", 5, _signed),
            ("Order amount matches the dispute", 5, _amount),
            ("Order ID on file", 5, _order),
        ],
    ),
    SNAD: (
        5,
        [
            ("Item matches the listing description", 35, _item),
            ("Refund or replacement offered", 10, _refund),
            ("Buyer correspondence on file", 15, _messages),
            ("Delivery confirmed by carrier", 15, _delivered),
            ("Order ID on file", 10, _order),
            ("Order amount matches the dispute", 10, _amount),
        ],
    ),
    "other": (
        10,
        [
            ("Order ID on file", 15, _order),
            ("Delivery confirmed by carrier", 20, _delivered),
            ("Delivered to the billing address", 20, _address),
            ("Order amount matches the dispute", 15, _amount),
            ("Buyer correspondence on file", 10, _messages),
            ("Tracking number provided", 10, _tracking),
        ],
    ),
}


FIGHT_AT = 60  # win probability at or above this: fight with evidence
ACCEPT_BELOW = 30  # below this: not worth fighting, accept the claim; in between, offer a refund


def recommend(probability: int) -> tuple[str, str]:
    """(action, plain-English reason) for a win probability: "fight", "offer_refund" or "accept"."""
    if probability >= FIGHT_AT:
        return "fight", f"A {probability}% chance of winning is at or above {FIGHT_AT}%, so the evidence is worth sending."
    if probability >= ACCEPT_BELOW:
        return (
            "offer_refund",
            f"A {probability}% chance of winning is between {ACCEPT_BELOW}% and {FIGHT_AT}%, so a partial refund offer is the safer move.",
        )
    return "accept", f"A {probability}% chance of winning is below {ACCEPT_BELOW}%, so accepting the claim costs less than fighting."


def score(dispute: Dispute, evidence: Evidence) -> ScoreResult:
    base, rules = _RULES.get(dispute.reason, _RULES["other"])
    factors = [Factor(label, weight, bool(check(dispute, evidence))) for label, weight, check in rules]
    total = base + sum(f.weight for f in factors if f.met)
    return ScoreResult(probability=max(0, min(100, total)), factors=factors)
