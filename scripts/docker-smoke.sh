#!/usr/bin/env bash
# Run `docker compose up` the way a judge would and check the token link, the gate and the page.
source "$(dirname "$0")/docker-common.sh"

export HOST_PORT=8788
HOST=http://127.0.0.1:$HOST_PORT
compose() { docker compose -p disputeshield-smoke "$@"; }
PLAIN=disputeshield-smoke-plain
trap 'compose down -v > /dev/null 2>&1 || true; docker rm -f "$PLAIN" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT

docker compose config > /dev/null
compose up -d --build
wait_health "$HOST"

logs=$(compose logs app 2>&1)
grep -q 'http://localhost:8000/' <<< "$logs" || { echo "no console link in logs" >&2; exit 1; }
token=$(grep -o '#token=[A-Za-z0-9_-]*' <<< "$logs" | head -n 1 | cut -d= -f2)
[ -n "$token" ] || { echo "no #token= in logs" >&2; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$HOST/api/disputes")" = 401 ] || { echo "expected 401 without token" >&2; exit 1; }
[ "$(code -H "Authorization: Bearer $token" "$HOST/api/disputes")" = 200 ] || { echo "expected 200 with token" >&2; exit 1; }
curl -fs "$HOST/" | grep -qi '<html' || { echo "GET / is not HTML" >&2; exit 1; }

# the bare image, no env at all, must fail closed: demo mode off
build
docker rm -f "$PLAIN" > /dev/null 2>&1 || true
docker run -d --name "$PLAIN" -p 8789:8000 "$IMAGE" > /dev/null
wait_health http://127.0.0.1:8789
curl -fs http://127.0.0.1:8789/api/config | grep -q '"demo_mode":false' || { echo "bare image has demo mode on" >&2; exit 1; }
echo "smoke ok"
