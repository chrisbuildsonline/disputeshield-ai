"""F10a: every /api route needs the operator token, except health, config and the PayPal webhook."""

import logging
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURE = Path(__file__).parent / "fixtures" / "dispute_created.json"
TOKEN = "test-operator-token"
EXEMPT = {("GET", "/api/health"), ("GET", "/api/config"), ("POST", "/api/webhooks/paypal")}


def protected_routes() -> list[tuple[str, str]]:
    # the OpenAPI schema lists every route, including those added through include_router
    found = []
    for route, ops in app.openapi()["paths"].items():
        for method in sorted(m.upper() for m in ops):
            if route.startswith("/api") and (method, route) not in EXEMPT:
                found.append((method, re.sub(r"\{[^}]+\}", "x", route)))
    return found


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPUTESHIELD_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("DISPUTESHIELD_OPERATOR_TOKEN", TOKEN)
    monkeypatch.setenv("DISPUTESHIELD_DEMO_MODE", "1")


@pytest.fixture
def anon() -> TestClient:
    return TestClient(app, headers={})


def test_route_list_is_not_empty() -> None:
    methods = {m for m, _ in protected_routes()}
    assert {"GET", "POST", "PUT"} <= methods
    assert len(protected_routes()) >= 8


@pytest.mark.parametrize(("method", "path"), protected_routes())
def test_no_header_is_401(anon: TestClient, method: str, path: str) -> None:
    r = anon.request(method, path)
    assert r.status_code == 401
    assert r.json() == {"detail": "Operator token needed"}
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(("method", "path"), protected_routes())
def test_wrong_token_is_401(anon: TestClient, method: str, path: str) -> None:
    r = anon.request(method, path, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    assert r.json() == {"detail": "Operator token needed"}


@pytest.mark.parametrize("header", ["Basic " + TOKEN, TOKEN, "Bearer", "Bearer  " + TOKEN])
def test_other_header_shapes_are_401(anon: TestClient, header: str) -> None:
    assert anon.get("/api/disputes", headers={"Authorization": header}).status_code == 401


def test_non_ascii_header_is_401_not_500(anon: TestClient) -> None:
    r = anon.get("/api/disputes", headers={b"Authorization": "Bearer café".encode("latin-1")})
    assert r.status_code == 401


def test_right_token_passes(anon: TestClient) -> None:
    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert anon.get("/api/disputes", headers=auth).status_code == 200
    assert anon.get("/api/autopilot", headers=auth).status_code == 200
    assert anon.post("/api/demo/chargeback", headers=auth).status_code == 200
    assert anon.get("/api/disputes/nope", headers=auth).status_code == 404


def test_open_routes_need_no_token(anon: TestClient) -> None:
    assert anon.get("/api/health").status_code == 200
    assert anon.get("/api/config").status_code == 200
    assert anon.get("/").status_code == 200


def test_webhook_needs_no_token(anon: TestClient) -> None:
    r = anon.post("/api/webhooks/paypal", content=b"{}")
    assert r.status_code == 422  # its own body check ran, not the token check


def test_webhook_keeps_its_own_signature_check(anon: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPUTESHIELD_DEMO_MODE")
    r = anon.post("/api/webhooks/paypal", content=FIXTURE.read_bytes())
    assert r.status_code in {401, 503}  # signature refused, or no PayPal webhook id to check against
    assert r.json()["detail"] != "Operator token needed"


def test_generated_tokens_differ() -> None:
    from app import auth

    assert auth.generate_token() != auth.generate_token()
    assert len(auth.generate_token()) >= 32


def test_env_token_is_used_and_blank_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import auth

    assert auth.operator_token() == TOKEN
    monkeypatch.setenv("DISPUTESHIELD_OPERATOR_TOKEN", "  ")
    generated = auth.operator_token()
    assert generated != "  " and len(generated) >= 32
    assert auth.operator_token() == generated  # stable for the life of the process
    monkeypatch.delenv("DISPUTESHIELD_OPERATOR_TOKEN")
    assert auth.operator_token() == generated


def test_link_is_logged(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import auth

    monkeypatch.setenv("PORT", "9123")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "Operator console: http://localhost:9123/ (token from DISPUTESHIELD_OPERATOR_TOKEN)" in caplog.text
    assert TOKEN not in caplog.text
    assert caplog.records[-1].levelno == logging.WARNING


def test_generated_token_link_is_logged(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import auth

    monkeypatch.delenv("DISPUTESHIELD_OPERATOR_TOKEN")
    monkeypatch.setenv("PORT", "9123")
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert f"Operator console: http://localhost:9123/#token={auth.operator_token()}" in caplog.text


def test_link_defaults_to_port_8000(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import auth

    monkeypatch.delenv("PORT", raising=False)
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        auth.log_link()
    assert "http://localhost:8000/ (token from DISPUTESHIELD_OPERATOR_TOKEN)" in caplog.text
