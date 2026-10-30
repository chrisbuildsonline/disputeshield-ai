#!/usr/bin/env bash
# Measurement only: pull each model into a throwaway CPU Ollama container, run the guarded extraction + note on it.
set -uo pipefail
cd "$(dirname "$0")/.."
export DOCKER_CONFIG=$(mktemp -d)
NAME=try-ollama
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
docker rm -f "$NAME" > /dev/null 2>&1 || true
docker run -d --name "$NAME" -p 11436:11434 -v disputeshield-try-models:/root/.ollama ollama/ollama > /dev/null
for _ in $(seq 60); do curl -fs http://127.0.0.1:11436/api/tags > /dev/null && break; sleep 1; done
for m in "$@"; do
  echo "=== $m"
  docker exec "$NAME" ollama pull "$m" > /dev/null 2>&1 || { echo "pull failed"; continue; }
  docker exec "$NAME" ollama list | grep "${m%%:*}"
  PYTHONPATH=. OLLAMA_HOST=http://127.0.0.1:11436 DISPUTESHIELD_OLLAMA_MODEL="$m" uv run python scripts/try_models.py 2>&1
done
