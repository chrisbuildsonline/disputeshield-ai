"""Print the OAuth scopes the sandbox app's token carries. Never prints keys or the token."""

import json
import os
import sys
from pathlib import Path

import httpx

ENV = Path(__file__).resolve().parent.parent / ".env"
BASE = "https://api-m.sandbox.paypal.com"


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        if key and value:
            os.environ.setdefault(key, value)


def main() -> int:
    load_env(ENV)
    cid, secret = os.environ.get("PAYPAL_CLIENT_ID"), os.environ.get("PAYPAL_CLIENT_SECRET")
    if not cid or not secret:
        print("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set in .env", file=sys.stderr)
        return 1
    base = os.environ.get("PAYPAL_API_BASE", BASE).rstrip("/")
    r = httpx.post(f"{base}/v1/oauth2/token", auth=(cid, secret), data={"grant_type": "client_credentials"}, timeout=15)
    if r.status_code != 200:
        print(f"token request failed: HTTP {r.status_code}", file=sys.stderr)
        return 1
    scopes = sorted(str(json.loads(r.text).get("scope", "")).split())
    print(f"{len(scopes)} scopes on {base}:")
    for s in scopes:
        print(" ", s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
