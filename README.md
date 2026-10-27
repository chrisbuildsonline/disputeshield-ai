# DisputeShield AI

Chargeback defense for PayPal merchants. It takes in PayPal dispute webhooks, reads your shipping and order PDFs, scores your chances of winning, and sends the evidence to PayPal.

Code: https://github.com/chrisbuildsonline/disputeshield-ai
Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## The problem

A small merchant gets a PayPal dispute ("item not received"). The proof is in a carrier receipt and an order export. Finding it, typing it up and answering inside the deadline takes time, and many merchants never answer. An unanswered dispute is a lost dispute.

## What it does

For a merchant who sells goods and ships them with a carrier:

1. A dispute arrives as a PayPal webhook (or from a sync of your sandbox disputes).
2. You upload the evidence PDFs, such as a UPS receipt or a CRM order export.
3. A model reads the PDF text into fields: carrier, tracking number, delivery time, address, signature, order id, amount.
4. A fixed rulebook scores the win probability. The model has no say in the score.
5. The app builds an evidence dossier with a short rebuttal note and sends it with PayPal's provide-evidence call.
6. Every step is written to an audit log.

### The demo

Click "Simulate chargeback". The app creates a simulated "item not received" dispute for USD 49.90. It attaches a sample UPS receipt PDF, the AI reads it, and the score comes out at 94%. Open the dispute and click "Submit evidence". In demo mode nothing leaves your machine and the UI says so. With autopilot on, the same flow submits by itself, with no click.

## Quick start (no keys)

You need Docker with Compose.

```
docker compose up
```

Wait for the build, then find this line in the logs and open the link:

```
Operator console: http://localhost:8000/#token=...
```

Click "Simulate chargeback". Demo mode is on in the compose file and shown with a "Demo mode" badge in the page header. To use another port, run `HOST_PORT=8790 docker compose up`. The logged link still says port 8000 (the port inside the container), so change the port in the link to your `HOST_PORT`.

Without Ollama the app still works, with regex reading and a template note, and the page shows "Regex fallback" and "Template" badges. See [AI models and tools](#ai-models-and-tools) to turn the model on.

## Run it locally (bun)

You need [bun](https://bun.sh), [uv](https://docs.astral.sh/uv/) and Python 3.12.

```
bun install
bun run setup
bun run e2e:install
bun run llm:start
bun run llm:pull
bun run dev
```

- `bun run setup` installs the Python packages (`uv sync`).
- `bun run e2e:install` installs the Chromium that the Playwright tests use. You only need it to run `bun run e2e`.
- `bun run llm:start` and `bun run llm:pull` are optional. They start Ollama as a user systemd service and pull `qwen3:8b` (about 5 GB). If you have Ollama some other way, run `ollama pull qwen3:8b` yourself.
- `bun run dev` builds the console, then serves it on http://localhost:8000 with demo mode on. Open the `#token=` link it logs.

`bun run dev` does not read `.env`. To use keys, export them first:

```
set -a; source .env; set +a
bun run dev
```

## AI models and tools

| Tool | Used for |
| --- | --- |
| qwen3:8b through [Ollama](https://ollama.com) | Default. Reads receipt and CRM PDF text into evidence fields. Drafts the rebuttal note. |
| Claude (optional, default model `claude-sonnet-5-5`) | Same two jobs, if you choose it. |
| pypdf | Turns the PDF into text for the model and for the regex parser. |
| PayPal Disputes API and webhooks | Reads disputes, verifies webhooks, provides evidence. |
| AG Grid Community | The dispute table in the console. |

Pick the model with `DISPUTESHIELD_LLM`:

- `ollama` (default, and the value for anything unknown). The server is `OLLAMA_HOST` (default `http://localhost:11434`) and the model is `DISPUTESHIELD_OLLAMA_MODEL` (default `qwen3:8b`).
- `claude` needs `ANTHROPIC_API_KEY`. Without the key it acts like `off`. Set `DISPUTESHIELD_CLAUDE_MODEL` to change the model id.
- `off` uses only the regex parser and the template note.

What the model does, and the guards around it:

- It reads the PDF text and fills the evidence fields. The text is treated as data, and the prompt tells the model to ignore instructions inside it.
- A tracking number, order id or amount must appear in the PDF text, or it is dropped.
- A labelled line in the PDF ("Tracking Number: ...") beats what the model returned for that field.
- Fields the model leaves empty are filled by the regex parser.
- The rebuttal note is written from the extracted facts only, then fact-checked. Any id, amount, date or time that is not in the dispute or the evidence rejects the note, and a fixed template note is used instead.
- If the model is down or fails, the regex parser and the template take over. The detail panel shows who did the work: an "AI" badge with the model name, "Regex fallback" or "Template".

Docker and Ollama: the compose file points the container at `http://host.docker.internal:11434`, so it uses the Ollama on your machine. On plain Linux Docker, Ollama listens on 127.0.0.1 by default and the container cannot reach it. Start Ollama with `OLLAMA_HOST=0.0.0.0` on the host. Otherwise you will see the fallback badges. Docker Desktop does not need this.

## PayPal sandbox keys (free)

Keys let the app talk to the real PayPal sandbox. They are free.

1. Go to https://developer.paypal.com and log in with a PayPal account, or sign up for one.
2. Open Apps & Credentials and switch to **Sandbox**.
3. Click Create App, give it a name, pick the Merchant type and create it. If the app page lists features, make sure Disputes is on.
4. Copy the Client ID and the Secret.
5. Copy `.env.example` to `.env` and fill in:

```
PAYPAL_CLIENT_ID=<client id>
PAYPAL_CLIENT_SECRET=<secret>
```

6. Restart. With compose, `docker compose up` reads `.env` by itself. With bun, export it as shown above.

`PAYPAL_API_BASE` defaults to `https://api-m.sandbox.paypal.com`. The app refuses to send evidence to any host that is not a `.sandbox.paypal.com` host.

What works with keys:

- `POST /api/disputes/sync` pulls the first page of your sandbox disputes into the console (there is no button for it; call it with the operator token, for example from `curl -X POST -H "Authorization: Bearer <token>" http://localhost:8000/api/disputes/sync`).
- Submitting a dispute that came from PayPal calls PayPal's provide-evidence endpoint with the dossier and the PDFs, then reads the dispute status back. The UI says "Sent to PayPal sandbox".

The honest limit: a sandbox dispute has to be opened by a sandbox buyer account on the sandbox website (sandbox.paypal.com). You pay a sandbox merchant with a sandbox buyer, then open a dispute as that buyer. There is no REST-only way to create one. Zero synced disputes is a normal result until you do that. This is why the demo has its own simulated chargeback.

### Webhooks

To receive real events, add a webhook to the sandbox app (Webhooks, Add Webhook). The URL must be public HTTPS, for example from a tunnel, and must point at `/api/webhooks/paypal`. Subscribe to the dispute created, updated and resolved events. Copy the Webhook ID into `PAYPAL_WEBHOOK_ID`.

- With `PAYPAL_WEBHOOK_ID` set, every webhook is checked with PayPal's verify-webhook-signature call. A bad or missing signature is refused.
- Without it, the webhook is refused with `503`, unless demo mode is on. Demo mode (`DISPUTESHIELD_DEMO_MODE=1`) accepts unsigned webhooks and stores them as "Simulated".

## Environment variables

All are in `.env.example`. The ones you are likely to set:

| Variable | Meaning |
| --- | --- |
| `DISPUTESHIELD_OPERATOR_TOKEN` | Fixed operator token. Blank means a random one per start. |
| `DISPUTESHIELD_DEMO_MODE` | `1` turns on the simulated chargeback and unsigned webhooks. On in compose and `bun run dev`. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials. |
| `PAYPAL_WEBHOOK_ID` | Turns on webhook signature checks. |
| `PAYPAL_API_BASE` | PayPal host. Sandbox only. |
| `DISPUTESHIELD_LLM` | `ollama`, `claude` or `off`. |
| `OLLAMA_HOST`, `DISPUTESHIELD_OLLAMA_MODEL` | Ollama server and model. |
| `ANTHROPIC_API_KEY`, `DISPUTESHIELD_CLAUDE_MODEL` | Optional Claude. |
| `DISPUTESHIELD_DB` | SQLite file. Default `data/disputeshield.db`. |
| `HOST_PORT` | Published port for `docker compose up`. Default 8000. |

## Operator token

The app never runs open. Every `/api` route (disputes, documents, scores, submit, sync, autopilot, the demo chargeback) needs `Authorization: Bearer <token>`. Without it the server answers `401` with `Operator token needed`.

- Set the token with the `DISPUTESHIELD_OPERATOR_TOKEN` environment variable.
- If it is unset or blank, the server makes a random token on every start.
- With a random token, the server logs a link when it starts: `Operator console: http://localhost:8000/#token=...` (the port is `PORT`, default 8000). Open it once. The page keeps the token in the browser and removes it from the address bar.
- With `DISPUTESHIELD_OPERATOR_TOKEN` set, the token is never logged. The server logs `Operator console: http://localhost:8000/ (token from DISPUTESHIELD_OPERATOR_TOKEN)`, and the page asks you to paste the token (or open `/#token=<your token>` yourself).
- Open on purpose: `GET /api/health`, `GET /api/config` and the PayPal webhook `POST /api/webhooks/paypal`. The webhook has its own signature check (or demo mode). The page itself holds no data, so it is open too.

## Autopilot

Autopilot is off by default. Turn it on with the switch in the page header, and set the threshold in the field next to it (default 85). The same settings are at `GET /api/autopilot` and `PUT /api/autopilot` with a body like `{"enabled": true, "threshold": 85}`.

It runs when a new dispute webhook arrives and when you add a document to a dispute. For each dispute it reads the evidence on file and scores it. Then:

- At or above the threshold, it submits the evidence, exactly as the submit button would.
- Below the threshold, or with no documents, or on an error, it does not submit. It flags the dispute "Needs review" and lists the reasons, including the score factors that were not met.
- Closed disputes and disputes that were already submitted are skipped.

Each step is written to the audit log. The demo chargeback always runs the agent once, so with autopilot off you see the "Autopilot is off" flag.

## Architecture

```
PayPal webhook / sync / demo chargeback
        |
        v
  webhooks.py  --> store.py (SQLite: disputes, documents, submissions, audit)
        |
  PDF upload --> extract.py (pypdf text -> model or regex -> guards)
        |
        v
  scorecard.py + scoring.py (deterministic win probability)
        |
        v
  dossier.py (evidence JSON, PDFs, rebuttal note, fact check)
        |
        v
  submit.py --> paypal.py (provide-evidence)  --> audit log
        ^
  autopilot.py (runs the same steps on its own)
```

| Path | Role |
| --- | --- |
| `app/main.py` | FastAPI app, wiring, health and config routes, serves the console. |
| `app/auth.py` | Operator token middleware and the console link. |
| `app/webhooks.py` | Webhook intake, signature check, dispute list and detail. |
| `app/store.py` | SQLite storage and the audit log. |
| `app/extract.py` | PDF text to evidence fields, with the guards. |
| `app/llm.py` | Picks the model and makes the Ollama call. |
| `app/scoring.py`, `app/scorecard.py` | The scorer, and the glue from stored rows to the scorer. |
| `app/dossier.py` | Builds the PayPal evidence payload and the rebuttal note. |
| `app/submit.py` | Documents, score preview, submit, audit and sync routes, demo chargeback. |
| `app/paypal.py` | OAuth and the Disputes API calls. |
| `app/autopilot.py` | The autopilot settings and agent. |
| `web/` | The console in TypeScript, built by `bun build` into `app/static`. |
| `samples/` | The sample UPS receipt and CRM order PDFs. |

## Scoring

The win probability is plain arithmetic, the same every time. Each dispute reason has a base number and a list of factors with weights. The score is the base plus the weight of every factor that is met, kept between 0 and 100. The weights are all positive, so more evidence never lowers the score.

For "item not received" the base is 9 and the factors are:

| Factor | Weight |
| --- | --- |
| Carrier and tracking number provided | 15 |
| Delivery confirmed by carrier | 20 |
| Delivered to the billing address | 25 |
| Signature on delivery | 15 |
| Order amount matches the dispute | 10 |
| Order ID on file | 6 |

That adds up to 100. The sample UPS receipt has everything except the order id, so the demo scores 94. Upload the sample CRM order export (`samples/crm_order.pdf`) as well and the order id is found, so it scores 100.

There are rulebooks for unauthorised use, item not as described, and a catch-all for other reasons. Some of their factors (address and card checks, prior orders, item matches the listing, refund offered) have no PDF extractor yet, so today they always count as not met.

## Tests and scripts

| Command | What it does |
| --- | --- |
| `bun run test` | Starts Ollama, builds the console, runs the whole pytest suite. |
| `bun run typecheck` | `tsc` for the console and strict `mypy` for `app` and `tests`. |
| `bun run e2e` | Playwright against a server it starts on port 8765, with the model and PayPal off. |
| `bun run e2e:alt` | The same on port 8766, if 8765 is taken. |
| `bun run docker:test` | Builds the image and runs pytest inside it. |
| `bun run docker:e2e` | Runs the Playwright suite against the container. |
| `bun run docker:smoke` | Runs `docker compose up` like a judge, checks the token link, the 401 gate and the page. |
| `bun run smoke:fresh` | Clones HEAD into a temp dir and follows this README there: compose without keys, bun without keys, then with your `.env` if you have one. |

## License

MIT, see LICENSE.
