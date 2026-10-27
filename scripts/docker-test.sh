#!/usr/bin/env bash
# Run the whole pytest suite inside the image, with the host's Ollama and the keys from .env.
source "$(dirname "$0")/docker-common.sh"

systemctl --user start ollama || true
build

NAME=disputeshield-test
LOG=$(mktemp)
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true; rm -f "$LOG"; rm -rf "$DOCKER_CONFIG"' EXIT
docker rm -f "$NAME" > /dev/null 2>&1 || true
# stdout can get swallowed, so pytest writes to a file in the container and we copy it out.
# Docker Desktop's host network is its VM, so localhost is not the host's Ollama: go through host.docker.internal.
docker run --name "$NAME" --network host --env-file .env \
  -e OLLAMA_HOST=http://host.docker.internal:11434 --add-host host.docker.internal:host-gateway "$IMAGE" \
  sh -c 'uv run pytest -q > /app/pytest.log 2>&1; echo exit=$? >> /app/pytest.log' || true
docker cp "$NAME:/app/pytest.log" "$LOG"
cat "$LOG"

grep -Eq '[0-9]+ passed' "$LOG" || { echo "no 'N passed' line" >&2; exit 1; }
if grep -Eq '[0-9]+ (failed|error|errors|skipped)' "$LOG"; then echo "failed/error/skipped in summary" >&2; exit 1; fi
[ "$(tail -n 1 "$LOG")" = "exit=0" ] || { echo "pytest did not exit 0" >&2; exit 1; }
echo "docker test ok"
