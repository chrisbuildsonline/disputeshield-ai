"""The grid lists open cases first, then by due date (soonest first, no date last), then the most recently updated."""

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import store
from app.main import app


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))


def put(did: str, status: str, due: str | None, updated: str = "2026-01-01T00:00:00Z", outcome: str | None = None) -> None:
    store.upsert_dispute(
        {
            "id": did,
            "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            "status": status,
            "amount_value": "10.00",
            "currency": "USD",
            "create_time": "2026-01-01T00:00:00Z",
            "update_time": updated,
            "seller_response_due_date": due,
            "outcome": outcome,
            "resource": "{}",
            "source": "simulated",
        }
    )


def ids() -> list[str]:
    rows: list[dict[str, Any]] = TestClient(app).get("/api/disputes").json()
    return [r["id"] for r in rows]


def test_open_first_then_due_date_nulls_last_then_recent() -> None:
    """Given open, closed, dated and undated disputes, when the grid is read, then the order follows the rule."""
    put("CLOSED-EARLY", "UNDER_REVIEW", "2026-01-02T00:00:00Z")
    put("OPEN-LATE", "OPEN", "2026-03-01T00:00:00Z")
    put("OPEN-NO-DUE-OLD", "OPEN", None, updated="2026-01-01T00:00:00Z")
    put("OPEN-SOON", "OPEN", "2026-02-01T00:00:00Z")
    put("OPEN-NO-DUE-NEW", "OPEN", None, updated="2026-02-01T00:00:00Z")
    put("WON", "OPEN", "2026-01-03T00:00:00Z", outcome="RESOLVED_SELLER_FAVOUR")
    put("RESOLVED", "RESOLVED", "2026-01-04T00:00:00Z")
    put("OFFER-OUT", "WAITING_FOR_BUYER_RESPONSE", None)
    put("OTHER", "OTHER", "2026-01-05T00:00:00Z")  # a status the console doesn't count as open: it sorts with the closed ones
    assert ids() == [
        "OPEN-SOON",
        "OPEN-LATE",
        "OPEN-NO-DUE-NEW",
        "OPEN-NO-DUE-OLD",
        "CLOSED-EARLY",
        "WON",
        "RESOLVED",
        "OTHER",
        "OFFER-OUT",
    ]


def test_same_due_date_falls_back_to_recent_then_id() -> None:
    """Given equal due dates, when the grid is read, then the latest update leads, then the id."""
    put("B", "OPEN", "2026-02-01T00:00:00Z", updated="2026-01-01T00:00:00Z")
    put("A", "OPEN", "2026-02-01T00:00:00Z", updated="2026-01-01T00:00:00Z")
    put("C", "OPEN", "2026-02-01T00:00:00Z", updated="2026-01-05T00:00:00Z")
    assert ids() == ["C", "A", "B"]
