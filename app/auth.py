"""Operator token: every /api route needs it, except health, config and the PayPal webhook."""

import hmac
import logging
import os
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import RequestResponseEndpoint

OPEN_ROUTES = {("GET", "/api/health"), ("GET", "/api/config"), ("POST", "/api/webhooks/paypal")}


def generate_token() -> str:
    return secrets.token_urlsafe(24)


_generated = generate_token()  # one per process start, used when the env var is unset or blank


def operator_token() -> str:
    return os.environ.get("DISPUTESHIELD_OPERATOR_TOKEN", "").strip() or _generated


def demo_mode() -> bool:
    return os.environ.get("DISPUTESHIELD_DEMO_MODE") == "1"


def log_link() -> None:
    port = os.environ.get("HOST_PORT") or os.environ.get("PORT") or "8000"  # the published port, not the container's
    log = logging.getLogger("uvicorn.error")
    demo = ' In demo mode the page has an "Open demo console" button.' if demo_mode() else ""
    if os.environ.get("DISPUTESHIELD_OPERATOR_TOKEN", "").strip():
        log.warning("Operator console: http://localhost:%s/ (token from DISPUTESHIELD_OPERATOR_TOKEN).%s", port, demo)
    else:
        log.warning("Operator console: http://localhost:%s/#token=%s%s", port, operator_token(), demo)


async def require_token(request: Request, call_next: RequestResponseEndpoint) -> Response:
    path = request.url.path
    if path.startswith("/api") and (request.method, path) not in OPEN_ROUTES:
        sent = request.headers.get("authorization", "")
        scheme, _, token = sent.partition(" ")
        if scheme != "Bearer" or not hmac.compare_digest(token.encode(), operator_token().encode()):
            return JSONResponse({"detail": "Operator token needed"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    return await call_next(request)
