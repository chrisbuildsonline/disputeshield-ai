import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.auth import demo_mode, log_link, operator_token, require_token
from app.autopilot import router as autopilot_router
from app.paypal import is_sandbox
from app.submit import router as submit_router
from app.webhooks import router

if demo_mode():
    if not is_sandbox():
        raise RuntimeError(
            "DISPUTESHIELD_DEMO_MODE=1 hands out the operator token and is sandbox-only: "
            "unset PAYPAL_API_BASE or set DISPUTESHIELD_DEMO_MODE=0"
        )
    logging.getLogger("uvicorn.error").warning(
        "DISPUTESHIELD_DEMO_MODE=1: PayPal webhooks are accepted without signature verification"
    )

log_link()

app = FastAPI(title="DisputeShield AI")
app.middleware("http")(require_token)
app.include_router(submit_router)  # /api/disputes/sync before /api/disputes/{id}
app.include_router(router)
app.include_router(autopilot_router)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/config")
def config() -> dict[str, bool | str | None]:
    demo = demo_mode()  # safe to hand out the token: demo mode is sandbox-only, refused at startup otherwise
    return {"demo_mode": demo, "demo_token": operator_token() if demo else None}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).parent / "static", html=True),
    name="static",
)
