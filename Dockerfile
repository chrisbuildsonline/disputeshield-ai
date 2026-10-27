FROM oven/bun:1 AS web
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
RUN bun run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8000 DISPUTESHIELD_DEMO_MODE=1 UV_FROZEN=1 PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen
COPY app ./app
COPY tests ./tests
COPY samples ./samples
COPY scripts ./scripts
COPY --from=web /src/app/static ./app/static
EXPOSE 8000
# the database lands in /app/data (DISPUTESHIELD_DB unset); uvicorn logs the operator console link to stderr
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port $PORT"]
