FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv@sha256:73d2665b478d8fa2de1cf105c6841f8e9cb6b09e568fc7700440c09f8fcd7ac4 /uv /uvx /bin/

RUN addgroup --system app && adduser --system --ingroup app app

WORKDIR /workspace
COPY common/python/expense-contracts/pyproject.toml common/python/expense-contracts/
COPY common/python/expense-contracts/src common/python/expense-contracts/src
COPY services/ai-worker/pyproject.toml services/ai-worker/uv.lock services/ai-worker/
COPY services/ai-worker/src services/ai-worker/src

WORKDIR /workspace/services/ai-worker
RUN uv sync --frozen --no-dev
RUN chown -R app:app /workspace

USER app
CMD [".venv/bin/python", "-m", "ai_worker.run_worker"]
