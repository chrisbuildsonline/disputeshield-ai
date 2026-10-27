import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.auth import log_link, require_token
from app.autopilot import router as autopilot_router
from app.submit import router as submit_router
from app.webhooks import router

if os.environ.get("DISPUTESHIELD_DEMO_MODE") == "1":
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
def config() -> dict[str, bool]:
    return {"demo_mode": os.environ.get("DISPUTESHIELD_DEMO_MODE") == "1"}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).parent / "static", html=True),
    name="static",
)
