# ADR-0011: `consensus/` and `market-data/` live under `packages/`

Status: accepted 2026-11-01 (owner). This cleanup phase.

Decision: `ai-trading/consensus/` (Vibe's private count bridge, SP4) and `ai-trading/market-data/` (the 01m Python facade + the Go bridge, rows 5R/5S/B0) move to **`ai-trading/packages/consensus/`** and **`ai-trading/packages/market-data/`**, next to our other first-party code (`packages/family-desk/`). `packages/` submodules stay untouched.

What changes: only repo-dir anchors — bake contexts, the consensus Dockerfile `COPY`, CI `working-directory` + the consensus test path, `smoke-test.sh`'s bind-mount, the backend Dockerfile comment, and doc pointers (02t + README + `THIRD_PARTY_NOTICES.md`). What does NOT change: registry image names (`ai-trading-market-data`, `ai-trading-market-data-bridge`, `ai-trading-vibe-consensus`), compose service names, mounted env files, Firestore profile names (`ai-trading/market-data`, `ai-trading/consensus`, `ai-trading/market-data-bridge`), the bridge's Go module path, container healthchecks, or any Python import (`ai_trading_common.*` lives in `common/`, not under the moved dirs).

Consequences: the deploy that carries the move re-proves the anchors (bridge still boots dark, smoke still exercises the market-data shape contract); future services start in `packages/` by default.
