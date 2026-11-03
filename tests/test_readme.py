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


@pytest.mark.parametrize("phrase", ["AG Grid Enterprise", "Claude 3.5"])
def test_stale_phrases_are_gone(phrase: str) -> None:
    assert phrase.lower() not in README.lower()


def test_stack_names_what_is_built() -> None:
    for phrase in ("AG Grid Community", "qwen3:8b", "Ollama", "Disputes API", "Invoicing API"):
        assert phrase in README


def test_repo_link_and_license() -> None:
    assert "https://github.com/chrisbuildsonline/disputeshield-ai" in README
    assert "MIT" in README


@pytest.mark.parametrize("heading", ["Quick start", "PayPal sandbox", "AI models", "Autopilot", "Architecture", "Scoring", "Tests"])
def test_required_sections(heading: str) -> None:
    headings = re.findall(r"(?m)^#{1,3} (.+)$", README)
    assert any(heading.lower() in h.lower() for h in headings), f"no '{heading}' heading"


def test_demo_video_script_is_wired_and_documented() -> None:
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert "scripts/demo-video.ts" in scripts.get("demo:video", "")
    assert (ROOT / "scripts" / "demo-video.ts").is_file()
    assert "bun run demo:video" in README
    assert "out/disputeshield-demo.mp4" in README


def test_demo_video_output_is_gitignored() -> None:
    assert "out/" in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()


def test_demo_video_is_type_checked() -> None:
    tsconfig = json.loads((ROOT / "tsconfig.json").read_text(encoding="utf-8"))
    assert "scripts" in tsconfig["include"]


IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)|<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", re.I)
WEB_HTML = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
WEB_TS = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "web" / "src").glob("*.ts"))


def _images() -> list[tuple[int, str]]:
    """(offset, path) for every Markdown and HTML image in the README."""
    return [(m.start(), m.group(1) or m.group(2)) for m in IMAGE.finditer(README)]


def _section(heading: str) -> str:
    m = re.search(rf"(?ms)^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", README)
    assert m, f"no '## {heading}' section"
    return m.group(1)


def test_readme_images_are_committed_files() -> None:
    images = _images()
    assert len(images) >= 3, f"README has {len(images)} images, wanted at least 3"
    for _, src in images:
        assert not re.match(r"(?i)^(?:[a-z]+:)?//", src), f"{src} is on an external host"
        path = (ROOT / src).resolve()
        assert path.is_relative_to(ROOT), f"{src} points outside the repo"
        assert path.is_file(), f"{src} does not exist"
        assert path.stat().st_size < 700_000, f"{src} is {path.stat().st_size} bytes, keep it under 700 KB"


def test_readme_hero_image_comes_before_the_first_section() -> None:
    images = _images()
    first_heading = re.search(r"(?m)^## ", README)
    assert images and first_heading
    assert images[0][0] < first_heading.start(), "the first image is not above the first ## heading"


def test_readme_screenshots_are_not_gitignored() -> None:
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    for _, src in _images():
        top = src.split("/")[0]
        assert f"{top}/" not in ignored and top not in ignored, f"{src} is gitignored"


def test_why_it_matters_cites_sources() -> None:
    links = re.findall(r"\]\((https?://[^)\s]+)\)|<(https?://[^>\s]+)>", _section("Why it matters"))
    assert len(links) >= 2, f"'Why it matters' links {len(links)} sources, wanted at least 2"


def test_code_link_and_built_for_render_as_separate_lines() -> None:
    lines = README.splitlines()
    code = next(i for i, line in enumerate(lines) if "github.com/chrisbuildsonline/disputeshield-ai" in line)
    built = next(i for i, line in enumerate(lines) if "Built for" in line)
    a, b = sorted((code, built))
    between = lines[a + 1 : b]
    as_list = all(re.match(r"\s*(?:[-*+]|\d+\.)\s", lines[i]) for i in (a, b))
    assert any(not line.strip() for line in between) or as_list or lines[a].endswith(("  ", "\\", "<br>")), (
        "the Code link and 'Built for' join into one paragraph"
    )


@pytest.mark.parametrize("label", ["Load sample disputes", "Sync from PayPal", "Simulate chargeback", "Accept claim", "Offer refund"])
def test_readme_names_the_real_console_controls(label: str) -> None:
    assert label in WEB_HTML or label in WEB_TS, f"the console has no '{label}' control"
    assert label in README, f"README does not name '{label}'"


def test_readme_shots_script_is_wired_and_documented() -> None:
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert "scripts/readme-shots.ts" in scripts.get("readme:shots", "")
    assert (ROOT / "scripts" / "readme-shots.ts").is_file()
    assert "bun run readme:shots" in README
    assert any(src.startswith("docs/screenshots/") for _, src in _images())


def test_readme_explains_recorded_reads() -> None:
    assert "samples/recorded.json" in README and "bun run llm:record" in README
    assert (ROOT / "samples" / "recorded.json").is_file()
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert "scripts/record_llm.py" in scripts["llm:record"]


def test_env_files_are_ignored_correctly() -> None:
    lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in lines
    assert "!.env.example" in lines
