"""`docker compose up` must run a local model sidecar, so the model-backed path works on a machine with no Ollama.

No YAML parser is installed, so this reads the compose file's two-space service blocks as text.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def service(name: str) -> str:
    m = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  \S|^\S|\Z)", COMPOSE)
    assert m, f"no {name} service"
    return m.group(1)


def readme_model() -> str:
    m = re.search(r"(?m)^Compose model: `([^`]+)`", README)
    assert m, "README must name the compose model on a line starting 'Compose model: `tag`'"
    return m.group(1)


def test_ollama_sidecar_has_volume_and_healthcheck() -> None:
    s = service("ollama")
    assert "image: ollama/ollama" in s
    assert re.search(r":/root/\.ollama\b", s)
    assert "healthcheck:" in s


def test_no_gpu_reservation() -> None:
    assert not re.search(r"(?i)\b(gpus|nvidia|devices|capabilities)\b", re.sub(r"(?m)#.*$", "", COMPOSE))


def test_pull_service_pulls_the_model_from_the_sidecar() -> None:
    s = service("ollama-pull")
    assert "image: ollama/ollama" in s
    assert "OLLAMA_HOST: ollama:11434" in s
    assert re.search(r"entrypoint:.*ollama.*pull", s)
    assert re.search(r"ollama:\n\s+condition: service_healthy", s)
    assert 'restart: "no"' in s


def test_app_waits_for_the_pull() -> None:
    s = service("app")
    assert re.search(r"ollama-pull:\n\s+condition: service_completed_successfully", s)


def test_app_talks_to_the_sidecar_by_default_and_can_be_overridden() -> None:
    s = service("app")
    assert "OLLAMA_HOST: ${OLLAMA_HOST:-http://ollama:11434}" in s
    assert "DISPUTESHIELD_OLLAMA_MODEL: ${DISPUTESHIELD_OLLAMA_MODEL:-" in s


def test_model_default_matches_readme_and_pull() -> None:
    model = readme_model()
    assert f"DISPUTESHIELD_OLLAMA_MODEL: ${{DISPUTESHIELD_OLLAMA_MODEL:-{model}}}" in service("app")
    assert f"${{DISPUTESHIELD_OLLAMA_MODEL:-{model}}}" in service("ollama-pull")


def test_models_volume_is_declared() -> None:
    assert re.search(r"(?m)^volumes:\n  \S+:", COMPOSE)
