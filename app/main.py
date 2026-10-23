from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="DisputeShield AI")


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


app.mount(
    "/",
    StaticFiles(directory=Path(__file__).parent / "static", html=True),
    name="static",
)
