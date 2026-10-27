# DisputeShield AI

Autonomous chargeback defense sentinel that ingests PayPal dispute webhooks, extracts transaction evidence from shipping and CRM PDFs, deterministically calculates win probability, and auto-submits structured counter-evidence dossiers via the PayPal Disputes API.

Built for [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Submissions close 2026-11-12.

## What it does

Autonomous chargeback defense sentinel that ingests PayPal dispute webhooks, extracts transaction evidence from shipping and CRM PDFs, deterministically calculates win probability, and auto-submits structured counter-evidence dossiers via the PayPal Disputes API.

## Stack

Python, FastAPI, PayPal Disputes REST API, PayPal Invoicing API, AG Grid Enterprise, Claude 3.5 Sonnet, Docker

## Operator token

The app never runs open. Every `/api` route (disputes, documents, scores, submit, sync, autopilot, the demo chargeback) needs `Authorization: Bearer <token>`. Without it the server answers `401` with `Operator token needed`.

- Set the token with the `DISPUTESHIELD_OPERATOR_TOKEN` environment variable.
- If it is unset or blank, the server makes a random token on every start.
- With a random token, the server logs a link when it starts: `Operator console: http://localhost:8000/#token=...` (the port is `PORT`, default 8000). Open it once. The page keeps the token in the browser and removes it from the address bar.
- With `DISPUTESHIELD_OPERATOR_TOKEN` set, the token is never logged. The server logs `Operator console: http://localhost:8000/ (token from DISPUTESHIELD_OPERATOR_TOKEN)`, and the page asks you to paste the token (or open `/#token=<your token>` yourself).
- Open on purpose: `GET /api/health`, `GET /api/config` and the PayPal webhook `POST /api/webhooks/paypal`. The webhook has its own signature check (or demo mode). The page itself holds no data, so it is open too.

## License

MIT, see LICENSE.
