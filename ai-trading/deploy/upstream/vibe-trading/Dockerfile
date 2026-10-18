# The upstream checkout is never edited. Reconstruct the tested family tree in
# a build-only stage before installing its hash-pinned dependencies and
# compiling its frontend. Full patches also retain tests/docs; Docker's
# upstream .dockerignore excludes those, so apply only image inputs here.
FROM python:3.11-slim@sha256:e031123e3d85762b141ad1cbc56452ba69c6e722ebf2f042cc0dc86c47c0d8b3 AS family-source
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=upstream . /src
COPY family-baseline.patch family-sp5.patch /tmp/
# actions/checkout uses a .git *file* for submodules. Docker's upstream
# .dockerignore excludes .git/ directories but not that gitfile; inside the
# build stage it points outside /src and breaks git apply. Drop only this
# copied metadata, never the upstream checkout or either patch.
RUN if [ -f /src/.git ]; then rm -f /src/.git; fi \
    && for patch in /tmp/family-baseline.patch /tmp/family-sp5.patch; do \
      git apply --binary --exclude='agent/tests/**' \
        --include='agent/**' --include='frontend/**' \
        --include='requirements-lock.txt' --include='requirements-channels-lock.txt' \
        --include='pyproject.toml' --include='README.md' "$patch"; \
    done

FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS frontend-build
WORKDIR /app/frontend
COPY --from=family-source /src/frontend/package.json /src/frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY --from=family-source /src/frontend/ ./
RUN npm run build

FROM python:3.11-slim@sha256:e031123e3d85762b141ad1cbc56452ba69c6e722ebf2f042cc0dc86c47c0d8b3 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
WORKDIR /app
COPY --from=family-source /src/agent/requirements.txt agent/requirements.txt
COPY --from=family-source /src/requirements-lock.txt requirements-lock.txt
RUN pip install --no-cache-dir --require-hashes -r requirements-lock.txt
COPY --from=family-source /src/requirements-channels-lock.txt requirements-channels-lock.txt
RUN pip install --no-cache-dir --require-hashes -r requirements-channels-lock.txt
COPY --from=family-source /src/pyproject.toml /src/LICENSE /src/README.md ./
COPY --from=family-source /src/agent/ agent/
RUN pip install --no-cache-dir --no-deps -e .

FROM python:3.11-slim@sha256:e031123e3d85762b141ad1cbc56452ba69c6e722ebf2f042cc0dc86c47c0d8b3 AS runtime
LABEL org.opencontainers.image.title="Vibe-Trading" \
    org.opencontainers.image.description="Family research Vibe-Trading overlay" \
    org.opencontainers.image.version="0.1.16" \
    org.opencontainers.image.source="https://github.com/HKUDS/Vibe-Trading" \
    org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libfontconfig1 \
    libgdk-pixbuf-2.0-0 libcairo2 fonts-dejavu-core fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY --from=builder /opt/venv /opt/venv
COPY --from=family-source /src/pyproject.toml /src/LICENSE /src/README.md ./
COPY --from=family-source /src/requirements-lock.txt requirements-lock.txt
COPY --from=family-source /src/agent/ agent/
COPY --from=frontend-build /app/frontend/dist frontend/dist
RUN useradd --create-home --shell /usr/sbin/nologin vibe \
    && useradd --system --no-create-home --shell /usr/sbin/nologin --uid 10001 vibe-sandbox \
    && mkdir -p agent/runs agent/sessions agent/uploads agent/.swarm/runs /home/vibe/.vibe-trading \
    && chown -R vibe:vibe /app /home/vibe/.vibe-trading

# These additions remain hash-pinned, with the family fork's dependency locks
# applied before the builder stage. Never re-resolve upstream dependencies.
COPY requirements-anthropic.lock /tmp/requirements-anthropic.lock
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements-anthropic.lock \
    && pip check \
    && rm /tmp/requirements-anthropic.lock
COPY start-vibe.py /usr/local/bin/start-vibe.py
USER vibe
EXPOSE 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8899/live')" || exit 1
CMD ["python", "/usr/local/bin/start-vibe.py", "vibe-trading", "serve", "--host", "0.0.0.0", "--port", "8899"]
