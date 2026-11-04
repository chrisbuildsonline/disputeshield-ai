"""A seeded case goes live on the sandbox only with demo mode off, keys and a sandbox base (no network here)."""

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import paypal
from app.submit import DEMO_LABEL
from test_invoice import AMT, actions, client, env, paypal_row, seed_demo  # noqa: F401  (fixtures are used by name)

LIVE_REC: dict[str, Any] = {
    "invoice_id": "INV2-AAAA-BBBB-CCCC-DDDD", "invoice_number": "0042", "status": "DRAFT", "total": AMT,
    "item": "Order A-1", "recipient": None, "debug_id": "dbg-create", "lookup_debug_id": "dbg-get", "verified": True,
}


def seeded_then(client: TestClient, monkeypatch: pytest.MonkeyPatch, *, demo: str = "0") -> tuple[str, list[Any]]:
    """Seed a simulated case (that needs demo mode), then set demo mode; record_invoice is replaced and counted."""
    did = seed_demo(client)[1]["id"]
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", demo)
    calls: list[Any] = []

    async def fake(item: str, amount: dict[str, Any], **kw: Any) -> dict[str, Any]:
        calls.append((item, amount))
        return dict(LIVE_REC)

    monkeypatch.setattr(paypal, "record_invoice", fake)
    return did, calls


def test_seeded_case_is_recorded_live_on_sandbox_when_demo_is_off(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    did, calls = seeded_then(client, monkeypatch)
    r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["source"], body["demo"]) == ("paypal", "live sandbox", False)
    assert body["simulated_case"] is True
    assert body["label"] == "Recorded on PayPal sandbox"
    assert (body["invoice_id"], body["debug_id"]) == (LIVE_REC["invoice_id"], "dbg-create")
    assert len(calls) == 1
    assert actions(client, did)[-1]["detail"]["simulated_case"] is True


def test_a_real_paypal_dispute_is_not_marked_simulated(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _, calls = seeded_then(client, monkeypatch)
    body = client.post(f"/api/disputes/{paypal_row()}/paypal-invoice").json()
    assert body["mode"] == "paypal" and body["simulated_case"] is False
    assert len(calls) == 1


@pytest.mark.parametrize("case", ["demo on", "no keys", "live base"])
def test_seeded_case_keeps_the_fixture_unless_all_three_hold(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    did, calls = seeded_then(client, monkeypatch, demo="1" if case == "demo on" else "0")
    if case == "no keys":
        monkeypatch.delenv("PAYPAL_CLIENT_ID")
        monkeypatch.delenv("PAYPAL_CLIENT_SECRET")
    if case == "live base":
        monkeypatch.setenv("PAYPAL_API_BASE", "https://api-m.paypal.com")
    r = client.post(f"/api/disputes/{did}/paypal-invoice")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["mode"], body["source"], body["demo"]) == ("demo", "demo", True)
    assert body["simulated_case"] is False
    assert body["label"] == DEMO_LABEL
    assert calls == []


def test_sandbox_guard_refuses_a_non_sandbox_base() -> None:
    def guard(base: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "scripts/check_sandbox.py"],
            env={**os.environ, "PAYPAL_API_BASE": base},
            capture_output=True, text=True, cwd=Path(__file__).parent.parent,
        )

    bad = guard("https://api-m.paypal.com")
    assert bad.returncode != 0
    assert "sandbox" in bad.stderr
    assert guard("https://api-m.sandbox.paypal.com").returncode == 0
