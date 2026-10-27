# Sourced by the docker-*.sh scripts: throwaway docker config (public images only), image build, health wait.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export DOCKER_CONFIG=$(mktemp -d)
IMAGE=disputeshield-ai:local

build() { docker build -t "$IMAGE" .; }

# wait_health <url>: poll /api/health for up to 60s
wait_health() {
  for _ in $(seq 60); do
    curl -fs "$1/api/health" > /dev/null && return 0
    sleep 1
  done
  echo "not healthy: $1" >&2
  return 1
}
