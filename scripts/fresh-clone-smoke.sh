#!/usr/bin/env bash
# Clone the committed HEAD into a temp dir (no .venv, node_modules, .env or built files) and follow the README there:
# the compose path and the bun path without keys, then the bun path again with the dev's .env if there is one.
source "$(dirname "$0")/docker-common.sh"

SRC=$PWD
TMP=$(mktemp -d)
CLONE=$TMP/repo
# two free ports (other dev servers may hold the usual ones)
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
COMPOSE_PORT=$(free_port)
BUN_PORT=$(free_port)
PROJECT=disputeshield-fresh
STEP="start"
SERVER_PID=""

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" > /dev/null 2>&1 || true
    wait "$SERVER_PID" > /dev/null 2>&1 || true  # the port must be free before the next server starts
  fi
  SERVER_PID=""
}
cleanup() {
  local rc=$?
  stop_server
  (cd "$CLONE" 2> /dev/null && HOST_PORT=$COMPOSE_PORT docker compose -p "$PROJECT" down -v --rmi local > /dev/null 2>&1) || true
  rm -rf "$TMP" "$DOCKER_CONFIG"
  [ "$rc" = 0 ] || echo "fresh-clone smoke FAILED at step: $STEP" >&2
}
trap cleanup EXIT

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

# check_server <base url> <token> <label>: the gate, the page, and the demo chargeback scoring 100
check_server() {
  local base=$1 token=$2 label=$3 dispute prob
  STEP="$label: 401 without the token"
  [ "$(code "$base/api/disputes")" = 401 ] || { echo "expected 401 without token" >&2; return 1; }
  STEP="$label: 200 with the token"
  [ "$(code -H "Authorization: Bearer $token" "$base/api/disputes")" = 200 ] || { echo "expected 200 with token" >&2; return 1; }
  STEP="$label: page loads"
  curl -fs "$base/" | grep -qi '<html' || { echo "GET / is not HTML" >&2; return 1; }
  curl -fs "$base/api/config" | grep -q '"demo_mode":true' || { echo "demo mode is not on" >&2; return 1; }
  STEP="$label: demo chargeback"
  dispute=$(curl -fs --max-time 120 -X POST -H "Authorization: Bearer $token" "$base/api/demo/chargeback" | json id)
  STEP="$label: demo chargeback scores 100"
  prob=$(curl -fs --max-time 180 -H "Authorization: Bearer $token" "$base/api/disputes/$dispute/score" | json probability)
  [ "$prob" = 100 ] || { echo "expected score 100, got $prob" >&2; return 1; }
  echo "$label: ok (dispute $dispute scored $prob)"
}

# start_bun_server <log>: uvicorn from the clone's own .venv, demo mode on, model off, its own database
start_bun_server() {
  (cd "$CLONE" && PORT=$BUN_PORT DISPUTESHIELD_DEMO_MODE=1 DISPUTESHIELD_LLM=off DISPUTESHIELD_DB="$TMP/bun.db" \
    exec .venv/bin/uvicorn app.main:app --port $BUN_PORT > "$1" 2>&1) &
  SERVER_PID=$!
  wait_health "http://127.0.0.1:$BUN_PORT"
}

STEP="git clone of HEAD"
git clone -q "$SRC" "$CLONE"
cd "$CLONE"
[ ! -e .env ] || { echo ".env must not be in the clone" >&2; exit 1; }

# ---- README: Quick start (no keys) ----
STEP="compose: docker compose up"
export HOST_PORT=$COMPOSE_PORT
docker compose -p "$PROJECT" up -d --build
STEP="compose: wait for health"
wait_health "http://127.0.0.1:$COMPOSE_PORT" 900 || { docker compose -p "$PROJECT" ps -a; docker compose -p "$PROJECT" logs app; exit 1; }
STEP="compose: token link in the logs"
token=$(docker compose -p "$PROJECT" logs app 2>&1 | grep -o 'Operator console: http://localhost:8000/#token=[A-Za-z0-9_-]*' | head -n 1 | cut -d= -f2)
[ -n "$token" ] || { echo "no Operator console #token= link in the logs" >&2; exit 1; }
check_server "http://127.0.0.1:$COMPOSE_PORT" "$token" "compose"
docker compose -p "$PROJECT" down -v --rmi local > /dev/null 2>&1

# ---- README: Run it locally (bun), no keys ----
STEP="bun: bun install"
bun install
STEP="bun: bun run setup"
bun run setup
STEP="bun: bun run build"
bun run build
STEP="bun: start the server"
start_bun_server "$TMP/bun.log"
token=$(grep -o '#token=[A-Za-z0-9_-]*' "$TMP/bun.log" | head -n 1 | cut -d= -f2)
[ -n "$token" ] || { echo "no #token= link in the server log" >&2; exit 1; }
check_server "http://127.0.0.1:$BUN_PORT" "$token" "bun"
stop_server

# ---- With keys: the dev's .env, if there is one ----
STEP="with keys"
if [ -f "$SRC/.env" ] && grep -q '^PAYPAL_CLIENT_ID=.' "$SRC/.env" && grep -q '^PAYPAL_CLIENT_SECRET=.' "$SRC/.env"; then
  cp "$SRC/.env" "$CLONE/.env"
  BUN_PORT=$(free_port)
  (
    set -a
    . "$CLONE/.env"
    set +a
    export DISPUTESHIELD_OPERATOR_TOKEN=fresh-smoke-token
    start_bun_server "$TMP/keys.log"
    STEP="with keys: POST /api/disputes/sync"
    status=$(curl -s -o "$TMP/sync.json" -w '%{http_code}' --max-time 60 -X POST \
      -H "Authorization: Bearer $DISPUTESHIELD_OPERATOR_TOKEN" "http://127.0.0.1:$BUN_PORT/api/disputes/sync")
    [ "$status" = 200 ] || { echo "sync returned $status: $(head -c 400 "$TMP/sync.json")" >&2; tail -n 5 "$TMP/keys.log" >&2; stop_server; exit 1; }
    stop_server
    echo "with keys: ok (sync returned 200)"
  )
else
  echo "skipped: no .env with PayPal keys"
fi

STEP="done"
echo "fresh-clone smoke: ok"
