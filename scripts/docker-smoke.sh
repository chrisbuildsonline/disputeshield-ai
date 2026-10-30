#!/usr/bin/env bash
# Run `docker compose up` the way a judge would and check the token link, the gate and the page.
source "$(dirname "$0")/docker-common.sh"

export HOST_PORT=8788
unset OLLAMA_HOST DISPUTESHIELD_OLLAMA_MODEL  # judge default: the ollama sidecar and the compose model
HOST=http://127.0.0.1:$HOST_PORT
compose() { docker compose -p disputeshield-smoke "$@"; }
PLAIN=disputeshield-smoke-plain
trap 'compose down -v > /dev/null 2>&1 || true; docker rm -f "$PLAIN" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT

docker compose config > /dev/null
compose up -d --build
wait_health "$HOST" 900  # the app starts after the one-off model pull

logs=$(compose logs app 2>&1)
grep -q 'http://localhost:8000/' <<< "$logs" || { echo "no console link in logs" >&2; exit 1; }
token=$(grep -o '#token=[A-Za-z0-9_-]*' <<< "$logs" | head -n 1 | cut -d= -f2)
[ -n "$token" ] || { echo "no #token= in logs" >&2; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$HOST/api/disputes")" = 401 ] || { echo "expected 401 without token" >&2; exit 1; }
[ "$(code -H "Authorization: Bearer $token" "$HOST/api/disputes")" = 200 ] || { echo "expected 200 with token" >&2; exit 1; }
curl -fs "$HOST/" | grep -qi '<html' || { echo "GET / is not HTML" >&2; exit 1; }

# no Ollama on the host: the sidecar's model must read the PDFs and write the note, not the regex/template fallback
auth="Authorization: Bearer $token"
dispute=$(curl -fs --max-time 180 -X POST -H "$auth" "$HOST/api/demo/chargeback" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -fs --max-time 180 -H "$auth" "$HOST/api/disputes/$dispute/score" | python3 -c '
import json, sys
d = json.load(sys.stdin)
sources = [x["evidence"]["source"] for x in d["documents"]]
assert sources and set(sources) == {"ollama"}, f"evidence sources {sources}"
assert d["dossier"]["note_source"] == "ollama", "note is not model-written"
assert d["probability"] == 94, "demo score " + str(d["probability"]) + " is not the fixed 94"
' || { echo "sidecar model did not do the extraction and note" >&2; exit 1; }

# the bare image, no env at all, must fail closed: demo mode off
build
docker rm -f "$PLAIN" > /dev/null 2>&1 || true
docker run -d --name "$PLAIN" -p 8789:8000 "$IMAGE" > /dev/null
wait_health http://127.0.0.1:8789
curl -fs http://127.0.0.1:8789/api/config | grep -q '"demo_mode":false' || { echo "bare image has demo mode on" >&2; exit 1; }
echo "smoke ok"
