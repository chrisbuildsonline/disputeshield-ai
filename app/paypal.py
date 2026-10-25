import json
import os
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.dossier import FILE_PART, INPUT_PART, Dossier

DEFAULT_BASE = "https://api-m.sandbox.paypal.com"
EXPIRY_MARGIN = 60.0

_token: tuple[str, float] | None = None


class PayPalError(Exception):
    def __init__(
        self, message: str, *, status: int | None = None, name: str | None = None, debug_id: str | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.name = name
        self.debug_id = debug_id


def api_base() -> str:
    return os.environ.get("PAYPAL_API_BASE", DEFAULT_BASE).rstrip("/")


async def get_token() -> str:
    global _token
    now = time.monotonic()
    if _token is not None and _token[1] > now:
        return _token[0]
    client_id = os.environ.get("PAYPAL_CLIENT_ID")
    secret = os.environ.get("PAYPAL_CLIENT_SECRET")
    if not client_id or not secret:
        raise PayPalError("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"{api_base()}/v1/oauth2/token",
                auth=(client_id, secret),
                data={"grant_type": "client_credentials"},
            )
    except httpx.TimeoutException as e:
        raise PayPalError("token request timed out") from e
    except httpx.HTTPError as e:
        raise PayPalError(f"token request failed: {type(e).__name__}") from e
    if r.status_code != 200:
        raise PayPalError(f"token request failed: {r.status_code}")
    try:
        body = r.json()
        token = str(body["access_token"])
        ttl = float(body.get("expires_in", 0))
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise PayPalError("bad token response") from e
    _token = (token, now + ttl - EXPIRY_MARGIN)
    return token


# ---- disputes API ----

_ID_RE = re.compile(r"[A-Za-z0-9-]+")
_MIME = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif"}
_ACTIONS = ("BUYER_EVIDENCE", "SELLER_EVIDENCE")
_OUTCOMES = ("BUYER_FAVOR", "SELLER_FAVOR")
_TIMEOUT = 30


def _dispute_url(dispute_id: str, suffix: str = "") -> str:
    if not isinstance(dispute_id, str) or not _ID_RE.fullmatch(dispute_id):
        raise PayPalError("invalid dispute id (letters, digits and - only)")
    return f"/v1/customer/disputes/{dispute_id}{suffix}"


def _require_sandbox() -> None:
    u = urlsplit(api_base())
    if u.scheme != "https" or not (u.hostname or "").endswith(".sandbox.paypal.com"):
        raise PayPalError("sandbox-only call refused: PAYPAL_API_BASE is not the sandbox")


def _error(r: httpx.Response) -> PayPalError:
    try:
        body = r.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        body = {}
    name = str(body["name"]) if body.get("name") else None
    message = str(body["message"]) if body.get("message") else None
    debug_id = str(body["debug_id"]) if body.get("debug_id") else r.headers.get("paypal-debug-id")
    text = f"PayPal HTTP {r.status_code}"
    for label, value in (("name", name), ("message", message), ("debug_id", debug_id)):
        if value:
            text += f" {label}={value}"
    return PayPalError(text, status=r.status_code, name=name, debug_id=debug_id)


async def _call(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    global _token
    r: httpx.Response | None = None
    for attempt in (1, 2):
        token = await get_token()
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
                r = await http.request(
                    method, f"{api_base()}{path}", headers={"Authorization": f"Bearer {token}"}, **kwargs
                )
        except httpx.TimeoutException as e:
            raise PayPalError(f"PayPal request timed out: {method} {path}") from e
        except httpx.HTTPError as e:
            raise PayPalError(f"PayPal request failed: {type(e).__name__}") from e
        if r.status_code == 401 and attempt == 1:
            _token = None
            continue
        break
    assert r is not None
    if not 200 <= r.status_code < 300:
        raise _error(r)
    if not r.content:
        return {}
    try:
        body = r.json()
    except ValueError as e:
        raise PayPalError(f"PayPal HTTP {r.status_code} with a non-JSON body", status=r.status_code) from e
    if not isinstance(body, dict):
        raise PayPalError(f"PayPal HTTP {r.status_code} with an unexpected body", status=r.status_code)
    return body


async def list_disputes(
    *, page_size: int | None = None, disputed_transaction_id: str | None = None, start_time: str | None = None
) -> dict[str, Any]:
    filters = (
        ("page_size", page_size),
        ("disputed_transaction_id", disputed_transaction_id),
        ("start_time", start_time),
    )
    return await _call("GET", "/v1/customer/disputes", params={k: v for k, v in filters if v is not None})


async def show_dispute(dispute_id: str) -> dict[str, Any]:
    return await _call("GET", _dispute_url(dispute_id))


async def provide_evidence(dispute_id: str, dossier: Dossier) -> dict[str, Any]:
    path = _dispute_url(dispute_id, "/provide-evidence")
    parts: list[tuple[str, tuple[str | None, bytes | str, str]]] = [
        (INPUT_PART, (None, json.dumps(dossier.input), "application/json"))
    ]
    for i, (name, data) in enumerate(dossier.files, 1):
        mime = _MIME.get(name.rsplit(".", 1)[-1].lower(), "application/octet-stream")
        parts.append((f"{FILE_PART}{i}", (name, data, mime)))
    return await _call("POST", path, files=parts)


async def require_evidence(dispute_id: str, action: str) -> dict[str, Any]:
    """Sandbox only: move a dispute to waiting for BUYER_EVIDENCE or SELLER_EVIDENCE."""
    path = _dispute_url(dispute_id, "/require-evidence")
    _require_sandbox()
    if action not in _ACTIONS:
        raise PayPalError(f"action must be one of {_ACTIONS}")
    return await _call("POST", path, json={"action": action})


async def adjudicate(dispute_id: str, outcome: str) -> dict[str, Any]:
    """Sandbox only: settle a dispute (it must be UNDER_REVIEW) as BUYER_FAVOR or SELLER_FAVOR."""
    path = _dispute_url(dispute_id, "/adjudicate")
    _require_sandbox()
    if outcome not in _OUTCOMES:
        raise PayPalError(f"outcome must be one of {_OUTCOMES}")
    return await _call("POST", path, json={"adjudication_outcome": outcome})
