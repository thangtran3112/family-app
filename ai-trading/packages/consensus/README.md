# Vibe consensus bridge

Location: `ai-trading/packages/consensus/` (moved from `ai-trading/consensus/` 2026-11-01) alongside `packages/market-data/`; build target, image, compose service, and Firestore profile names (`ai-trading/consensus`, `ai-trading-vibe-consensus`) are unchanged. Deploy only (compose + `deploy.sh`) mounts or renders; nothing mounts the repo path at runtime.

Private Python 3.12 service: `GET /healthz` and authenticated `GET /v1/recommendations/AAPL.US` (`X-API-Key: VIBE_A...Y`). Uses `ai_trading_common.registry.DataSources` with Finnhub as the only targets source. Returns counts and the source's monthly period, never price targets. Missing optional free Finnhub key returns `503 not_configured`; `/healthz` stays healthy. No public route or port belongs on this service.

Run tests from `ai-trading/common`: `uv run pytest -q ../packages/consensus/test_server.py`. Build from the repository root: `docker build -t vibe-consensus:local -f ai-trading/packages/consensus/Dockerfile ai-trading`.
