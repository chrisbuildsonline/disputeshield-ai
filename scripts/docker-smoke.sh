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
grep -q 'http://localhost:8788/' <<< "$logs" || { echo "no console link with the HOST_PORT in logs" >&2; exit 1; }
token=$(grep -o '#token=[A-Za-z0-9_-]*' <<< "$logs" | head -n 1 | cut -d= -f2)
[ -n "$token" ] || { echo "no #token= in logs" >&2; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$HOST/api/disputes")" = 401 ] || { echo "expected 401 without token" >&2; exit 1; }
[ "$(code -H "Authorization: Bearer $token" "$HOST/api/disputes")" = 200 ] || { echo "expected 200 with token" >&2; exit 1; }
curl -fs "$HOST/" | grep -qi '<html' || { echo "GET / is not HTML" >&2; exit 1; }

# no Ollama on the host: the sidecar's model must read the PDFs and write the note, not the regex/template fallback
auth="Authorization: Bearer $token"
dispute=$(curl -fs --max-time 180 -X POST -H "$auth" "$HOST/api/demo/chargeback" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
note=$(curl -fs --max-time 180 -H "$auth" "$HOST/api/disputes/$dispute/dossier" | python3 -c 'import json,sys; print(json.load(sys.stdin)["note_source"])')
[ "$note" = "ollama" ] || { echo "note is not model-written ($note)" >&2; exit 1; }
curl -fs --max-time 180 -H "$auth" "$HOST/api/disputes/$dispute/score" | python3 -c '
import json, sys
d = json.load(sys.stdin)
sources = [x["evidence"]["source"] for x in d["documents"]]
assert sources and set(sources) == {"ollama"}, f"evidence sources {sources}"
assert d["probability"] == 100, "demo score " + str(d["probability"]) + " is not the fixed 100"
' || { echo "sidecar model did not do the extraction and note" >&2; exit 1; }

# the bare image, no env at all: a judge's plain docker run is in demo mode and hands the console its token
build
docker rm -f "$PLAIN" > /dev/null 2>&1 || true
docker run -d --name "$PLAIN" -p 8789:8000 "$IMAGE" > /dev/null
PLAIN_URL=http://127.0.0.1:8789
wait_health "$PLAIN_URL"
read -r demo_mode demo_token < <(curl -fs "$PLAIN_URL/api/config" | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(c["demo_mode"], c["demo_token"])
')
[ "$demo_mode" = True ] || { echo "bare image is not in demo mode" >&2; exit 1; }
[ -n "$demo_token" ] && [ "$demo_token" != None ] || { echo "no demo_token from /api/config" >&2; exit 1; }
[ "$(code "$PLAIN_URL/api/disputes")" = 401 ] || { echo "bare image: expected 401 without token" >&2; exit 1; }
[ "$(code -H "Authorization: Bearer $demo_token" "$PLAIN_URL/api/disputes")" = 200 ] || { echo "bare image: expected 200 with the demo token" >&2; exit 1; }

# a judge without Ollama: the seeded sample cases show the recorded model reads, not the regex fallback
seed_start=$SECONDS
curl -fs --max-time 60 -X POST -H "Authorization: Bearer $demo_token" "$PLAIN_URL/api/demo/seed" | python3 -c '
import json, sys
print(" ".join(d["id"] for d in json.load(sys.stdin)["disputes"]))
' > "$DOCKER_CONFIG/ids"
echo "seed took $((SECONDS - seed_start))s"
for id in $(cat "$DOCKER_CONFIG/ids"); do
  curl -fs -H "Authorization: Bearer $demo_token" "$PLAIN_URL/api/disputes/$id/documents" | python3 -c '
import json, sys
sources = [x["evidence"]["source"] for x in json.load(sys.stdin)]
assert sources and set(sources) == {"recorded"}, f"sources {sources}"
' || { echo "no-Ollama seed did not use the recorded reads" >&2; exit 1; }
done
echo "smoke ok"
