# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
WORKDIR /src/common
COPY common/pyproject.toml common/uv.lock ./
RUN uv sync --frozen --no-dev --no-editable --no-install-project
COPY common/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
COPY --from=build /src/common/.venv /opt/venv
COPY consensus/server.py /app/server.py
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER app
WORKDIR /app
CMD ["python", "server.py"]
