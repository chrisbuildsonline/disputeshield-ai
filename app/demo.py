"""The demo chargebacks: five fictional cases, each tied to the sample PDFs that back it."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from app import scorecard
from app.scoring import INR, SNAD, UNAUTHORISED


@dataclass(frozen=True)
class Scenario:
    key: str
    reason: str
    currency: str
    value: str
    billing: str  # the buyer's billing address; it becomes the resource's buyer_billing_address
    docs: tuple[str, ...]  # file names under samples/
    due_hours: int  # hours from now until the seller response is due
    buyer: str
    message: str


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "leeds", INR, "USD", "49.90", "12 High Street, Leeds LS1 4AB", ("ups_receipt.pdf",),
        168, "Jo Smith", "item not received",
    ),
    Scenario(
        "lisbon", INR, "EUR", "128.00", "Rua Augusta 88, 1100-048 Lisboa", ("dhl_lisbon_receipt.pdf",),
        120, "Marta Nunes", "my parcel never came",
    ),
    Scenario(
        "oslo", SNAD, "NOK", "1299.00", "Storgata 14, 0155 Oslo", ("postnord_oslo_receipt.pdf", "crm_oslo_order.pdf"),
        30, "Ola Berg", "the jacket is not what the listing showed",
    ),
    Scenario(
        "bristol", INR, "GBP", "86.40", "5 Park Row, Bristol BS1 5LJ", ("dpd_bristol_receipt.pdf",),
        96, "Sam Holt", "nothing arrived at my house",
    ),
    Scenario(
        "madrid", UNAUTHORISED, "EUR", "312.50", "Calle Mayor 21, 28013 Madrid", ("seur_madrid_receipt.pdf",),
        144, "Carlos Vega", "I did not make this purchase",
    ),
)


def resource(s: Scenario) -> dict[str, Any]:
    """A fresh PayPal-shaped dispute resource (CUSTOMER.DISPUTE.CREATED) for the scenario."""
    now = datetime.now(UTC)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {
        "dispute_id": f"PP-D-{uuid4().hex[:10].upper()}",
        "reason": s.reason,
        "status": "OPEN",
        "dispute_amount": {"currency_code": s.currency, "value": s.value},
        "create_time": stamp,
        "update_time": stamp,
        "seller_response_due_date": (now + timedelta(hours=s.due_hours)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "dispute_channel": "INTERNAL",
        "messages": [{"posted_by": "BUYER", "time_posted": stamp, "content": s.message}],
        "buyer": {"name": s.buyer},
        scorecard.BILLING_KEY: s.billing,
    }
