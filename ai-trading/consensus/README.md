# Vibe consensus bridge

Private Python 3.12 service: `GET /healthz` and authenticated `GET /v1/recommendations/AAPL.US` (`X-API-Key: VIBE_API_AUTH_KEY`). Uses `ai_trading_common.registry.DataSources` with Finnhub as the only targets source. Returns counts and the source's monthly period, never price targets. Missing optional free Finnhub key returns `503 not_configured`; `/healthz` stays healthy. No public route or port belongs on this service.

Run tests from `ai-trading/common`: `uv run pytest -q ../consensus/test_server.py`. Build from the repository root: `docker build -t vibe-consensus:local -f ai-trading/consensus/Dockerfile ai-trading`.
