"""The README is the first thing a judge runs, so its commands, env vars and claims are checked against the repo."""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
README = (ROOT / "README.md").read_text(encoding="utf-8")
ENV_EXAMPLE = ROOT / ".env.example"
ENV_NAME = r"(?:DISPUTESHIELD|PAYPAL|OLLAMA|ANTHROPIC)_[A-Z][A-Z0-9_]*"
# read by the app, or (HOST_PORT, E2E_*) by the compose file and the Playwright config
APP_SOURCE = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "app").glob("*.py"))
OTHER_SOURCE = "\n".join((ROOT / n).read_text(encoding="utf-8") for n in ("docker-compose.yml", "playwright.config.ts"))


def test_bun_run_commands_exist() -> None:
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    used = set(re.findall(r"bun run ([\w:-]+)", README))
    assert used, "README names no bun run commands"
    assert sorted(used - scripts.keys()) == []


def test_env_example_names_are_read_by_the_code() -> None:
    assert ENV_EXAMPLE.is_file(), ".env.example is missing"
    names = re.findall(r"(?m)^#?\s*([A-Z][A-Z0-9_]*)=", ENV_EXAMPLE.read_text(encoding="utf-8"))
    assert names
    unread = [n for n in names if n not in APP_SOURCE and n not in OTHER_SOURCE]
    assert unread == []


def test_env_example_has_every_variable_the_app_reads() -> None:
    read = set(re.findall(rf'environ\.get\("({ENV_NAME})"', APP_SOURCE))
    assert len(read) >= 10
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    assert sorted(n for n in read if f"{n}=" not in text) == []


def test_env_example_has_no_secrets() -> None:
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if re.search(r"KEY|SECRET|TOKEN", name):
            assert not value.strip() or line.startswith("#"), f"{name} has a value"


def test_readme_env_names_are_read_by_the_code() -> None:
    names = set(re.findall(rf"\b{ENV_NAME}\b", README))
    assert names
    assert sorted(n for n in names if n not in APP_SOURCE) == []


@pytest.mark.parametrize("phrase", ["AG Grid Enterprise", "Claude 3.5", "Invoicing API"])
def test_stale_phrases_are_gone(phrase: str) -> None:
    assert phrase.lower() not in README.lower()


def test_stack_names_what_is_built() -> None:
    for phrase in ("AG Grid Community", "qwen3:8b", "Ollama", "Disputes API"):
        assert phrase in README


def test_repo_link_and_license() -> None:
    assert "https://github.com/chrisbuildsonline/disputeshield-ai" in README
    assert "MIT" in README


@pytest.mark.parametrize("heading", ["Quick start", "PayPal sandbox", "AI models", "Autopilot", "Architecture", "Scoring", "Tests"])
def test_required_sections(heading: str) -> None:
    headings = re.findall(r"(?m)^#{1,3} (.+)$", README)
    assert any(heading.lower() in h.lower() for h in headings), f"no '{heading}' heading"


def test_env_files_are_ignored_correctly() -> None:
    lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in lines
    assert "!.env.example" in lines
