FROM oven/bun:1 AS web
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
RUN bun run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
# demo mode is on by default so a plain `docker run` works with no keys; -e DISPUTESHIELD_DEMO_MODE=0 turns it off
ENV DISPUTESHIELD_DEMO_MODE=1 PYTHONUNBUFFERED=1 PORT=8000 UV_FROZEN=1 PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen
COPY app ./app
COPY tests ./tests
COPY samples ./samples
COPY scripts ./scripts
COPY web ./web
COPY docs/screenshots ./docs/screenshots
# the repo-wiring tests (README, compose, scripts) read these from the repo root
COPY README.md Dockerfile docker-compose.yml playwright.config.ts package.json tsconfig.json .gitignore .env.example ./
COPY --from=web /src/app/static ./app/static
EXPOSE 8000
# the database lands in /app/data (DISPUTESHIELD_DB unset); uvicorn logs the operator console link to stderr
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port $PORT"]
