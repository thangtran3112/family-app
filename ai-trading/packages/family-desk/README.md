# Family Desk

The family's own trading desk (Release 2): user-owned, versioned strategies that alert automatically and paper-trade on IBKR paper. Design: [02a](../../plans/subplans/02a-desk-v1-strategies-design.md). Plan and phase status: [02c](../../plans/subplans/02c-desk-v1-implementation-plan.md).

| Path | What |
|---|---|
| `contracts/` | Zod strategy-spec schema (the source of truth), its generated JSON Schema, shared fixtures, and the seeded templates |
| `backend/` | Python 3.12 (uv): Pydantic models generated from the JSON Schema, and the pure strategy core (`ai_trading.core`) |
| `frontend/` | The Desk web app (Phase 4) |

This package never imports another package. Code shared with other ai-trading packages lives in `ai-trading/common/`, and code adapted from an upstream app is copied in with attribution (`ai-trading/AGENTS.md`, "Our Code").

```bash
cd contracts && pnpm install && pnpm typecheck && pnpm test
cd backend && uv sync && uv run ruff check . && uv run pytest -q
```

For frontend development, install the linked contracts dependencies first, then the frontend:

```bash
cd frontend
pnpm --dir ../contracts install --frozen-lockfile
pnpm install --frozen-lockfile
```

After changing the schema, run `pnpm generate:json-schema` in `contracts/`, then `scripts/generate-contracts.sh` in `backend/`. The tests fail until both generated files are current.

## Practice (replay) data prep

The Practice lane (`/api/desk/replay/*`, plan `02o`) replays a finished past day from Alpaca history. Bars and prints are cached compressed in `replay_blobs`, so a day fetched once never touches Alpaca again. Preload the days you will practise on (read-only market data, no orders):

```bash
cd backend
# 50 symbols over the last 21 sessions: raw 1-minute bars + 10 prior sessions + daily bars (about 170 HTTP requests, ~80 s)
uv run python -m ai_trading.cli.replay_prep bars --file universe.txt --last-sessions 21
# Tape pre-warm is opt-in per symbol and day (a dense day is millions of prints; NVDA's first hour is ~380k, ~25 s)
uv run python -m ai_trading.cli.replay_prep tape --symbols NVDA,TSLA --days 2026-10-22 --mode first-hour
uv run python -m ai_trading.cli.replay_prep days --watchlists   # backfill the notable-days table (the daily close keeps it current)
uv run python -m ai_trading.cli.replay_prep status
```

Needs `DESK_RUNTIME_DATABASE_URL` and the Alpaca keys (render them with `common/config/family_config.py run ai-trading/desk -- ...`; nothing is printed). `DESK_REPLAY_STUB=1` swaps the data for a trimmed real TSLA fixture day (development only, never set in a deployed environment).
