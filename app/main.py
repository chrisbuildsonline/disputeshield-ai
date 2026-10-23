from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.webhooks import router

app = FastAPI(title="DisputeShield AI")
app.include_router(router)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).parent / "static", html=True),
    name="static",
)
