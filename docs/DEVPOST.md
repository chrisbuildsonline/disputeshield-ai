# Devpost draft: DisputeShield AI

Draft on Devpost: https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1292330-disputeshield-ai  
Repo: https://github.com/chrisbuildsonline/disputeshield-ai (MIT, public).  
Local demo video: out/disputeshield-demo.mp4 (1080p, ~2:58). Replace YOUTUBE_URL after upload.

## Status (filled on Devpost draft)

- Project overview: tagline, thumbnail
- Project details: story, Built with (16 tags), GitHub try-it link, 6 gallery images
- Additional info: Individual / Sweden, New project, PayPal+AI tech write-up, AG Grid, repo, testing, eligibility
- Still needed: YouTube URL on Project details, then Submit

## Elevator pitch / tagline

Autonomous PayPal chargeback defense: local AI reads shipping PDFs, scores win odds with fixed rules, and submits evidence via the PayPal Disputes API.

## Project story (pasted)

## Inspiration

A small merchant gets a PayPal dispute for "item not received." The proof is usually already on hand: a carrier receipt and an order export. Finding it, typing it up, and answering inside the 10-day window still takes time, and many sellers never respond. An unanswered dispute is a lost dispute.

PayPal's own seller help says that if you do not respond within those 10 days and the buyer escalates, the case goes to the buyer. Chargebacks keep growing, and each loss costs more than the sale. We wanted a local, autonomous defense loop that uses PayPal's own Disputes API instead of another dashboard the merchant has to babysit.

## What it does

DisputeShield AI is chargeback defense for PayPal merchants:

1. A dispute arrives as a PayPal webhook (or from a sync of sandbox disputes).
2. You upload evidence PDFs (UPS receipt, CRM order export).
3. A local model (Ollama qwen3:8b / compose qwen2.5:3b; optional Claude) reads PDF text into structured fields.
4. A fixed rulebook scores win probability. The model has no say in the score. Displayed win chance never exceeds 95%.
5. The app builds an evidence dossier with a fact-checked rebuttal note and can send it with PayPal provide-evidence.
6. Autopilot can auto-submit above a threshold or flag for review. Weak cases recommend offer refund / accept claim.
7. A second PayPal API family (Invoicing v2) records the disputed order as a sandbox draft invoice.
8. Operators work in an AG Grid console on desktop and phone.

## How we built it

- **Backend:** FastAPI on Python 3.12 with uv, Docker / Compose for a zero-key demo.
- **PayPal:** Disputes API + webhooks for the case lifecycle; Invoicing v2 for the second API surface on sandbox.
- **AI:** Ollama for PDF evidence extraction and rebuttal notes; optional Claude for the same jobs; pypdf for text; regex fallback when no model is up.
- **Console:** TypeScript + Bun front end with AG Grid Community.
- **Quality:** Playwright e2e; recorded reads for sample PDFs so the demo stays reproducible; American voice clone for the demo video narration.

Judges can run the zero-key path:

```
docker build -t disputeshield .
docker run --rm -p 127.0.0.1:8000:8000 disputeshield
```

Open http://localhost:8000 → **Open demo console** → **Simulate chargeback**. Or `docker compose up` for the Operator console with a CPU Ollama sidecar.

## Challenges we ran into

- **Trust vs. AI:** Win odds cannot be a model opinion. Scoring is a fixed rulebook; the LLM only extracts fields and drafts a note that still has to pass a fact check against the PDF fields.
- **Sandbox reality:** Provide-evidence and sync need sandbox credentials; a real sandbox dispute still needs a sandbox buyer. Demo mode keeps the full loop local so judges can evaluate without keys.
- **Weak cases:** Fighting every claim is wrong. Under ~60% the UI pushes offer refund / accept claim instead of autopilot submit.
- **Reproducible demos:** Live model reads vary. Sample disputes ship with recorded reads of the same PDFs so screenshots and walkthroughs stay stable.

## What we learned

Local models are good enough for receipt and CRM extraction when the prompt is narrow and the score stays deterministic. PayPal's Disputes + Invoicing APIs are enough to show a real two-API merchant workflow on sandbox. The hard product problem is the decision policy (fight / refund / accept), not another chat UI.

## What's next

Tighten autopilot thresholds with more labeled cases, harden webhook auth for production keys, and expand carrier parsers beyond the sample UPS / PostNord receipts.


## Built with / Tools

python, fastapi, typescript, bun, docker, ollama, qwen, paypal, paypal-disputes-api, paypal-invoicing-api, ag-grid, pypdf, playwright, claude, ai, chargebacks

## Newly created during the submission period

Yes. Built from scratch for the PayPal AI Hackathon submission window (started 2026-10-22 on the Win Board; public repo chrisbuildsonline/disputeshield-ai).

## How to run (judges)

Zero-key demo:

```
docker build -t disputeshield .
docker run --rm -p 127.0.0.1:8000:8000 disputeshield
```

Open http://localhost:8000 → **Open demo console** → **Simulate chargeback**.

Or: `docker compose up` and open the logged Operator console link. Compose pulls qwen2.5:3b into a CPU Ollama sidecar (~2 GB first start).

Sandbox keys (free): see README "PayPal sandbox keys". Sync / provide-evidence need sandbox credentials; a real sandbox dispute still needs a sandbox buyer on sandbox.paypal.com.

## Demo video

YOUTUBE_URL

Local file: out/disputeshield-demo.mp4 (1920x1080, ~177 s, original music, American voice clone, product shown in a browser window).
