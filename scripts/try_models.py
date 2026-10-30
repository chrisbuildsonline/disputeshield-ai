"""Time guarded extraction and the rebuttal note for the current DISPUTESHIELD_OLLAMA_MODEL on both sample PDFs."""

import json
import time
from pathlib import Path

from app import extract, llm
from app.dossier import build_dossier
from app.scoring import Dispute, score

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
model = llm.ollama_model()
evs = []
for name in ("ups_receipt.pdf", "crm_order.pdf"):
    t = time.time()
    ev = extract.extract((SAMPLES / name).read_bytes())
    print(f"{model} {name} extract {time.time() - t:.1f}s source={ev.source} model={ev.model}")
    print(json.dumps(ev.model_dump(exclude={"source", "model"}), sort_keys=True))
    evs.append(ev)
dispute = Dispute(reason="MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount="49.90", billing_address="12 High Street, Leeds LS1 4AB")
result = score(dispute, __import__("app.scorecard", fromlist=["merge"]).merge(evs))
t = time.time()
d = build_dossier(dispute, evs, result)
print(f"{model} note {time.time() - t:.1f}s source={d.note_source} model={d.note_model} why={d.notes}")
print(d.input["evidences"][0]["notes"])
