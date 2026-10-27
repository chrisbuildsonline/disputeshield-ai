#!/usr/bin/env bash
# Run the existing Playwright suite against the image, in a fresh container so the database starts empty.
source "$(dirname "$0")/docker-common.sh"

build

NAME=disputeshield-e2e
PORT=8777
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
docker rm -f "$NAME" > /dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT":8000 \
  -e DISPUTESHIELD_DEMO_MODE=1 -e DISPUTESHIELD_OPERATOR_TOKEN=e2e-token -e DISPUTESHIELD_LLM=off \
  -e PAYPAL_CLIENT_ID= -e PAYPAL_CLIENT_SECRET= -e PAYPAL_WEBHOOK_ID= -e ANTHROPIC_API_KEY= \
  "$IMAGE" > /dev/null
wait_health "http://127.0.0.1:$PORT"

E2E_BASE_URL="http://127.0.0.1:$PORT" bunx playwright test
