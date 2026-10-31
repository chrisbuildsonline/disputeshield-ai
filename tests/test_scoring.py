from __future__ import annotations

import dataclasses
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.scoring import ACCEPT_BELOW, FIGHT_AT, Dispute, Evidence, ScoreResult, recommend, score

INR = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
UNAUTH = "UNAUTHORISED"
SNAD = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
ADDR = "12 High Street, Leeds LS1 4AB"

REASONS = [INR, UNAUTH, SNAD, "DUPLICATE", "", "whatever"]


def dispute(reason: str = INR, amount: str = "49.90", addr: str | None = ADDR) -> Dispute:
    return Dispute(reason=reason, amount=Decimal(amount), billing_address=addr)


DEMO = Evidence(
    carrier="UPS",
    tracking_number="1Z999AA10123456784",
    delivered_at="2026-10-01T10:00:00Z",
    delivered_to="12 HIGH  street,  leeds ls1 4ab.",
    signed_by="J Smith",
    amount=Decimal("49.9"),
)

FULL = Evidence(
    carrier="UPS",
    tracking_number="1Z999AA10123456784",
    delivered_at="2026-10-01T10:00:00Z",
    delivered_to=ADDR,
    signed_by="J Smith",
    order_id="A-1",
    amount=Decimal("49.90"),
    customer_messages=("Thanks, it arrived",),
    avs_match=True,
    cvv_match=True,
    prior_orders_from_buyer=3,
    item_description_matches=True,
    refund_offered=True,
)


def test_demo_scores_exactly_94() -> None:
    result = score(dispute(), DEMO)
    assert result.probability == 94
    assert all(f.label and f.weight > 0 for f in result.factors)


def test_inr_no_evidence_is_low() -> None:
    assert score(dispute(), Evidence()).probability <= 20


@pytest.mark.parametrize("reason", REASONS)
def test_empty_low_and_full_high(reason: str) -> None:
    empty = score(dispute(reason), Evidence())
    full = score(dispute(reason), FULL)
    assert 0 <= empty.probability <= 20
    assert full.probability >= 90
    assert full.probability > empty.probability
    assert not any(f.met for f in empty.factors)
    assert all(f.met for f in full.factors)


@pytest.mark.parametrize("reason", REASONS)
def test_partial_between(reason: str) -> None:
    partial = Evidence(order_id="A-1", carrier="UPS", tracking_number="X1")
    p = score(dispute(reason), partial).probability
    assert score(dispute(reason), Evidence()).probability < p < score(dispute(reason), FULL).probability


@pytest.mark.parametrize("reason", REASONS)
def test_every_factor_listed_with_positive_weight(reason: str) -> None:
    a = score(dispute(reason), Evidence())
    b = score(dispute(reason), FULL)
    assert [f.label for f in a.factors] == [f.label for f in b.factors]
    assert len(a.factors) >= 4
    assert all(f.weight > 0 for f in a.factors)


@pytest.mark.parametrize(
    "delivered_to",
    ["12 high street leeds ls1 4ab", "  12   HIGH STREET,, Leeds LS1-4AB ", "12 High Street. Leeds, LS1 4AB!"],
)
def test_address_normalisation(delivered_to: str) -> None:
    ev = dataclasses.replace(DEMO, delivered_to=delivered_to)
    assert score(dispute(), ev).probability == 94


@pytest.mark.parametrize("delivered_to", [None, "", "   ", "99 Other Road", "..."])
def test_address_mismatch(delivered_to: str | None) -> None:
    ev = dataclasses.replace(DEMO, delivered_to=delivered_to)
    assert score(dispute(), ev).probability < 94


def test_blank_billing_address_never_matches() -> None:
    ev = dataclasses.replace(DEMO, delivered_to="...")
    assert score(dispute(addr="..."), ev).probability < 94
    assert score(dispute(addr=None), DEMO).probability < 94


@pytest.mark.parametrize(
    "evidence_amount,dispute_amount,matches",
    [
        (Decimal("49.9"), "49.90", True),
        ("49.90", "49.9", True),
        (Decimal("49.900"), "49.90", True),
        (Decimal("49.91"), "49.90", False),
        ("junk", "49.90", False),
        ("NaN", "49.90", False),
        (None, "49.90", False),
    ],
)
def test_amount_normalisation(evidence_amount: Any, dispute_amount: str, matches: bool) -> None:
    ev = dataclasses.replace(DEMO, amount=evidence_amount)
    p = score(dispute(amount=dispute_amount), ev).probability
    assert (p == 94) is matches


def test_delivered_at_accepts_datetime() -> None:
    ev = dataclasses.replace(DEMO, delivered_at=datetime(2026, 10, 1, 10, 0))
    assert score(dispute(), ev).probability == 94


def test_unknown_reason_uses_other() -> None:
    a = score(dispute("SOMETHING_NEW"), FULL)
    b = score(dispute("DUPLICATE"), FULL)
    assert a == b
    assert a.factors != score(dispute(INR), FULL).factors


def test_to_dict_is_json_ready() -> None:
    import json

    d = score(dispute(), DEMO).to_dict()
    json.dumps(d)
    assert d["probability"] == 94
    assert set(d["factors"][0]) == {"label", "weight", "met"}


# ---- property tests ----

text = st.none() | st.text(max_size=30)
opt_bool = st.none() | st.booleans()
decimals = st.none() | st.decimals(allow_nan=True, allow_infinity=True) | st.text(max_size=10)

evidence_st = st.builds(
    Evidence,
    carrier=text,
    tracking_number=text,
    delivered_at=text | st.datetimes(),
    delivered_to=text,
    signed_by=text,
    order_id=text,
    amount=decimals,
    customer_messages=st.lists(st.text(max_size=20), max_size=3).map(tuple),
    avs_match=opt_bool,
    cvv_match=opt_bool,
    prior_orders_from_buyer=st.none() | st.integers(min_value=-5, max_value=10),
    item_description_matches=opt_bool,
    refund_offered=opt_bool,
)
dispute_st = st.builds(
    Dispute,
    reason=st.sampled_from(REASONS) | st.text(max_size=20),
    amount=st.decimals(allow_nan=False, allow_infinity=False, places=2),
    billing_address=text,
)


@given(dispute_st, evidence_st)
def test_never_raises_and_bounded(d: Dispute, e: Evidence) -> None:
    r: ScoreResult = score(d, e)
    assert isinstance(r.probability, int)
    assert 0 <= r.probability <= 100
    assert r.factors


def _enablers(d: Dispute) -> list[dict[str, Any]]:
    return [
        {"carrier": "UPS"},
        {"tracking_number": "1Z1"},
        {"delivered_at": "2026-10-01"},
        {"delivered_to": d.billing_address or "1 Road"},
        {"signed_by": "J Smith"},
        {"order_id": "A-1"},
        {"amount": d.amount},
        {"customer_messages": ("hello",)},
        {"avs_match": True},
        {"cvv_match": True},
        {"prior_orders_from_buyer": 2},
        {"item_description_matches": True},
        {"refund_offered": True},
    ]


@given(dispute_st, evidence_st, st.integers(min_value=0, max_value=12))
def test_monotonic_when_enabling_a_field(d: Dispute, e: Evidence, i: int) -> None:
    change = _enablers(d)[i]
    before = score(d, e)
    after = score(d, dataclasses.replace(e, **change))
    assert after.probability >= before.probability
    for b, a in zip(before.factors, after.factors, strict=True):
        assert not (b.met and not a.met)


# ---- recommendation ----


@pytest.mark.parametrize(
    "p,action",
    [(0, "accept"), (29, "accept"), (30, "offer_refund"), (59, "offer_refund"), (60, "fight"), (94, "fight"), (100, "fight")],
)
def test_recommend_boundaries(p: int, action: str) -> None:
    got, reason = recommend(p)
    assert got == action
    assert str(p) in reason
    assert reason.endswith(".")


def test_recommend_cutoffs_are_documented_constants() -> None:
    assert (FIGHT_AT, ACCEPT_BELOW) == (60, 30)
