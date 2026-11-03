"""A judge runs a plain `docker run` and reaches the console with no env vars and no keys."""

import importlib.util
import logging
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app

ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_config_in_demo_mode_hands_out_the_env_token(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    monkeypatch.setenv("DISPUTESHIELD_OPERATOR_TOKEN", "env-token")
    assert client.get("/api/config").json() == {"demo_mode": True, "demo_token": "env-token"}


def test_config_in_demo_mode_hands_out_the_generated_token(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    monkeypatch.delenv("DISPUTESHIELD_OPERATOR_TOKEN", raising=False)
    body = client.get("/api/config").json()
    assert body == {"demo_mode": True, "demo_token": auth.operator_token()}
    assert len(body["demo_token"]) >= 32
    assert client.get("/api/disputes", headers={"Authorization": f"Bearer {body['demo_token']}"}).status_code == 200


@pytest.mark.parametrize("value", [None, "0", "true", ""])
def test_config_with_demo_mode_off_has_no_token(client: TestClient, monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    monkeypatch.setenv("DISPUTESHIELD_OPERATOR_TOKEN", "env-token")
    if value is None:
        monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE", raising=False)
    else:
        monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", value)
    assert client.get("/api/config").json() == {"demo_mode": False, "demo_token": None}
    monkeypatch.delenv("DISPUTESHIELD_OPERATOR_TOKEN")
    assert client.get("/api/config").json() == {"demo_mode": False, "demo_token": None}


def test_link_prefers_host_port_over_port(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "8000")
    monkeypatch.setenv("HOST_PORT", "8788")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "localhost:8788" in caplog.text
    assert "localhost:8000" not in caplog.text


def test_link_falls_back_to_port_then_8000(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOST_PORT", raising=False)
    monkeypatch.setenv("PORT", "9123")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "localhost:9123" in caplog.text
    caplog.clear()
    monkeypatch.delenv("PORT")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "localhost:8000" in caplog.text


@pytest.mark.parametrize("token", [None, "env-token"])
def test_demo_mode_link_mentions_the_demo_button(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, token: str | None
) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")
    if token:
        monkeypatch.setenv("DISPUTESHIELD_OPERATOR_TOKEN", token)
    else:
        monkeypatch.delenv("DISPUTESHIELD_OPERATOR_TOKEN", raising=False)
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "Open demo console" in caplog.text
    caplog.clear()
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "0")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "Open demo console" not in caplog.text


def import_main_fresh() -> None:
    spec = importlib.util.spec_from_file_location("main_fresh", ROOT / "app" / "main.py")
    assert spec and spec.loader
    spec.loader.exec_module(importlib.util.module_from_spec(spec))


@pytest.mark.parametrize(
    ("demo", "base", "ok"),
    [
        ("1", "https://api-m.paypal.com", False),
        ("1", "https://api-m.sandbox.paypal.com", True),
        ("0", "https://api-m.paypal.com", True),
    ],
)
def test_demo_mode_refuses_to_start_against_production_paypal(
    monkeypatch: pytest.MonkeyPatch, demo: str, base: str, ok: bool
) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", demo)
    monkeypatch.setenv("PAYPAL_API_BASE", base)
    if ok:
        import_main_fresh()
    else:
        with pytest.raises(RuntimeError, match="sandbox-only"):
            import_main_fresh()


def test_dockerfile_turns_demo_mode_on_by_default() -> None:
    assert re.search(r"(?m)^ENV\b.*\bDISPUTESHIELD_DEMO_MODE=1\b", DOCKERFILE)


def test_compose_passes_host_port_to_the_app() -> None:
    assert "HOST_PORT: ${HOST_PORT:-8000}" in COMPOSE


def test_readme_has_a_try_it_section_with_the_three_steps() -> None:
    m = re.search(r"(?ms)^## Try it in 60 seconds\s*$(.*?)(?=^## |\Z)", README)
    assert m, "no 'Try it in 60 seconds' section"
    body = m.group(1)
    assert "docker build -t disputeshield ." in body
    assert "docker run --rm -p 8000:8000 disputeshield" in body
    assert "http://localhost:8000" in body and "Open demo console" in body
    assert "DISPUTESHIELD_DEMO_MODE=0" in body
    assert README.index("Try it in 60 seconds") < README.index("## Why it matters")
