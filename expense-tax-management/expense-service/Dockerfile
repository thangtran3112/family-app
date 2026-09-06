FROM python:3.13-slim

WORKDIR /app

# Install system dependencies (curl for healthcheck, libpq for postgres)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Copy dependency configuration
COPY pyproject.toml .

# Install dependencies using uv
RUN uv sync --frozen --no-install-project || uv sync --no-install-project

# Copy application source code
COPY . .

# Expose FastAPI port
EXPOSE 8000

# Run uvicorn via uv
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
