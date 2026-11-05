"""F27: the console can name the model that runs a slow step, and a submit does not run the note model twice."""

import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import submit
from app.dossier import build_dossier
from app.main import app

SAMPLES = Path(__file__).parent.parent / "samples"


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "sub" / "test.db"))
    for key in (
        "PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY",
        "DISPUTESHIELD_OLLAMA_MODEL", "DISPUTESHIELD_CLAUDE_MODEL", "DISPUTESHIELD_READ_DELAY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    submit._PREVIEWS.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_config_names_the_model_that_would_run(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "off")
    assert client.get("/api/config").json()["llm_model"] is None  # nothing is called, so nothing is named
    monkeypatch.setenv("DISPUTESHIELD_LLM", "ollama")
    assert client.get("/api/config").json()["llm_model"] == "qwen3:8b"
    monkeypatch.setenv("DISPUTESHIELD_OLLAMA_MODEL", "llama3.2")
    assert client.get("/api/config").json()["llm_model"] == "llama3.2"
    monkeypatch.setenv("DISPUTESHIELD_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("DISPUTESHIELD_CLAUDE_MODEL", "claude-test")
    assert client.get("/api/config").json()["llm_model"] == "claude-test"


def test_config_says_whether_a_submit_calls_paypal(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get("/api/config").json()["paypal"] is False
    monkeypatch.setenv("PAYPAL_CLIENT_ID", "id")
    monkeypatch.setenv("PAYPAL_CLIENT_SECRET", "secret")
    assert client.get("/api/config").json()["paypal"] is True


def test_read_delay_hook_slows_an_upload_only_when_set(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "off")
    did = client.post("/api/demo/chargeback").json()["id"]
    pdf = (SAMPLES / "crm_order.pdf").read_bytes()
    t0 = time.monotonic()
    assert client.post(f"/api/disputes/{did}/documents", params={"name": "a.pdf"}, content=pdf).status_code == 200
    fast = time.monotonic() - t0
    monkeypatch.setenv("DISPUTESHIELD_READ_DELAY", "0.5")
    t0 = time.monotonic()
    assert client.post(f"/api/disputes/{did}/documents", params={"name": "b.pdf"}, content=pdf).status_code == 200
    assert time.monotonic() - t0 >= 0.5
    assert fast < 0.5


def test_submit_reuses_the_note_the_preview_wrote(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_LLM", "off")
    real = build_dossier
    chosen: list[Any] = []

    def spy(*a: Any, **k: Any) -> Any:
        chosen.append(k.get("note_choice"))
        return real(*a, **k)

    monkeypatch.setattr(submit, "build_dossier", spy)
    did = client.post("/api/demo/chargeback").json()["id"]
    client.get(f"/api/disputes/{did}/dossier")
    assert chosen == [None]  # the preview chose the note
    r = client.post(f"/api/disputes/{did}/submit")
    assert r.status_code == 200, r.text
    assert chosen[1] is not None  # the submit used that choice, it did not ask the model again
