# syntax=docker/dockerfile:1.7
# Family Desk backend image: one image, two entrypoints -- `api` (uvicorn)
# and `scheduler` -- docker-compose.yml's `command:` picks which to run
# (02c Shared Interfaces: "both run from one image"). "Our code" convention
# (brief L6): alongside ai-trading/auth/Dockerfile and
# ai-trading/market-data/Dockerfile, never under deploy/upstream/ (that's
# for the four submodule apps only).
#
# Build context is ai-trading/ (NOT this file's own directory): see
# docker-bake.hcl's "desk" target. packages/family-desk/backend/pyproject.toml
# resolves its `ai-trading-common` dependency as `../../../common` --
# relative to the repo layout -- so both directories must be copied into the
# build with that same relative layout preserved, which a context scoped to
# just the backend directory could not do.
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /src/packages/family-desk/backend
# Installs exactly what the lock pins; a stale lock fails the build loudly
# (same two-step -- deps first, source second -- as deploy/upstream/mirofish/
# Dockerfile, so an unchanged lock keeps the dependency layer cached).
COPY common /src/common
COPY packages/family-desk/backend/pyproject.toml packages/family-desk/backend/uv.lock ./
# --no-editable: pyproject.toml's tool.uv.sources marks ai-trading-common
# editable (an absolute /src/common path) for local dev; without this flag
# the venv built here would keep pointing at that build-stage-only path,
# which the final stage below never copies in. --no-editable installs it as
# a normal built wheel instead, so the final image needs nothing but its own
# venv (verified empirically: a plain `uv sync --frozen` here produced a venv
# that ImportError'd on ai_trading_common once /src/common was gone).
RUN uv sync --frozen --no-dev --no-editable --no-install-project
COPY packages/family-desk/backend .
RUN uv sync --frozen --no-dev --no-editable

FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /src/packages/family-desk/backend /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER app
WORKDIR /app
EXPOSE 8000
# No CMD (brief L6): docker-compose.yml's `command:` selects
# `python -m uvicorn ai_trading.api.main:app --host 0.0.0.0 --port 8000` for `api` (the
# Console scripts in /app/.venv/bin keep their build-stage shebang (/src/...), so run
# tools as `python -m <tool>` here; a bare `uvicorn` exits with "no such file".
# one served ASGI app; integration fix, PROTO-BRIEF.md) or
# `python -m ai_trading.jobs.scheduler` for `scheduler` from this one image.
