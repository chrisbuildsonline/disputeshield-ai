import os
import time

import httpx

DEFAULT_BASE = "https://api-m.sandbox.paypal.com"
EXPIRY_MARGIN = 60.0

_token: tuple[str, float] | None = None


class PayPalError(Exception):
    pass


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
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(
            f"{api_base()}/v1/oauth2/token",
            auth=(client_id, secret),
            data={"grant_type": "client_credentials"},
        )
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
