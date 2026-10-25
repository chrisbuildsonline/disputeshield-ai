import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.submit import router as submit_router
from app.webhooks import router

if os.environ.get("DISPUTESHIELD_DEMO_MODE") == "1":
    logging.getLogger("uvicorn.error").warning(
        "DISPUTESHIELD_DEMO_MODE=1: PayPal webhooks are accepted without signature verification"
    )

app = FastAPI(title="DisputeShield AI")
app.include_router(submit_router)  # /api/disputes/sync before /api/disputes/{id}
app.include_router(router)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).parent / "static", html=True),
    name="static",
)
