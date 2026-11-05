"""F28: a person never sees a win chance above 95%. The raw score (and the scoring rules) stay as they are."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.scoring import FIGHT_AT, display_win, recommend


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.mark.parametrize(("raw", "shown"), [(0, 0), (25, 25), (94, 94), (95, 95), (96, 95), (99, 95), (100, 95)])
def test_display_win_caps_at_95(raw: int, shown: int) -> None:
    assert display_win(raw) == shown


@pytest.mark.parametrize("raw", range(0, 101))
def test_recommendation_prose_never_says_100(raw: int) -> None:
    reason = recommend(raw)[1]
    assert "100%" not in reason
    assert f"{display_win(raw)}%" in reason


def test_a_perfect_case_reads_naturally() -> None:
    action, reason = recommend(100)
    assert action == "fight"
    assert reason.startswith("Strong case: about a 95% chance of winning")


def test_a_94_case_keeps_its_number() -> None:
    assert "94% chance of winning" in recommend(94)[1]


def test_score_route_keeps_raw_but_prose_is_capped() -> None:
    client = TestClient(app)
    did = client.post("/api/demo/chargeback").json()["id"]
    s = client.get(f"/api/disputes/{did}/score").json()
    assert s["probability"] == 100
    assert "100%" not in s["recommendation"]["reason"]
    assert "95%" in s["recommendation"]["reason"]
    assert FIGHT_AT < 95


def test_kpi_averages_the_capped_values() -> None:
    client = TestClient(app)
    client.post("/api/demo/seed")
    assert client.get("/api/summary").json()["avg_win"] == round((95 + 79 + 55 + 44 + 25) / 5)


def test_a_single_perfect_case_never_averages_to_100() -> None:
    client = TestClient(app)
    client.post("/api/demo/chargeback")
    assert client.get("/api/summary").json()["avg_win"] == 95
