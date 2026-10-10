# Handoff: Family Desk v1, Phase 0 Spike and Phase 1 Planning

**Date:** 2026-10-10
**From:** the ai-trading main session that designed Desk v1 and started the spike (session root was the repository root)
**For:** the next ai-trading main session, started with the working directory `ai-trading/`
**Read first:**
- `../AGENTS.md` (shared checkout)
- `AGENTS.md`
- `plans/subplans/02a-desk-v1-strategies-design.md`
- `plans/subplans/02c-desk-v1-implementation-plan.md`
- `plans/subplans/02c-desk-v1-tasks/phase-0-spike.md`
- `plans/subplans/02d-desk-spike-results.md`

Paths below are relative to `ai-trading/` unless they start with `../`.

## Where Things Stand (updated 2026-10-10, evening)

| Item | State |
|---|---|
| Design | Approved and on `dev`: `02a` (Desk v1), `02b` (market data); decisions in `STATUS.md` (2026-10-10 rows), including the Desk layout row. |
| Layout | The Desk lives in `packages/family-desk/` (`contracts/`, `backend/`, `frontend/` from Phase 4). Packages never import each other; code shared by two or more ai-trading packages (provider clients such as Alpaca and IBKR, a shared database schema, shared types) goes in `ai-trading/common/`. Upstream code is copied in with attribution (`AGENTS.md` "Our Code"). |
| Mockups | Paper file "TobyTest", page "Family Desk · R2 mockups": D1 Today, D2 Strategies, D3 Paper, D8 New from template (row 1); D4 Watchlists, D5 Holdings, D6 Ask, D7 Settings (row 2); mobile M2, M3, M5, M6 More. Indexed in `02a` §16. |
| Phase 0 spike | Tasks 0.1–0.4 done; the owner created the IBKR data user and is waiting for IBKR's approval. Tasks 0.5–0.6 (probes, gateway layout) wait on that. Owner guide: `plans/subplans/02e-ibkr-data-user-setup.md`. |
| Phase 1 strategy core | Done, merged to `dev` (PR #95), then moved to `packages/family-desk/` (on `feature/toby`, not yet on `dev`). Contracts 38 tests, backend 107 tests, CI job "Desk contracts and backend". |
| Git | `feature/toby` holds the move, the mockup index, and rule edits (root and package `AGENTS.md`, expense rules); they ship with the next phase PR (one PR per finished phase). |

## Next Steps, in Order

The owner chose, in order: more mockups (done), port quant tools, Phase 2 data without IBKR, and the Desk frontend shell. Each gets a task file under `plans/subplans/02c-desk-v1-tasks/` (writing-plans skill), owner review, then subagent-driven execution in a `.worktrees/` worktree merged back into `feature/toby`.

1. **Port quant tools** (pure, in `packages/family-desk/backend/src/ai_trading/core/`, with `packages/family-desk/THIRD_PARTY_NOTICES.md`):
   - Black-Scholes price, greeks, and the implied-volatility solver from Vibe-Trading `agent/src/quantlib/options.py` (MIT), on the standard library instead of scipy; no barrier options;
   - covered-call math from 02 §6.3 (eligibility, filters, metrics, flags, score, roll candidates, short-call risk rules);
   - support/resistance from Vibe-Trading `agent/src/tools/pattern_tool.py` (MIT), with pivots confirmed only after `window` closed bars (the upstream centered window would repaint), wired into the spec as a level operand;
   - order sizing with clamps and an audit trail, after ai-hedge-fund `hedge_fund/risk/limits.py` (MIT). Persona prompts wait for Phase 5's LLM call.
2. **Phase 2 data without IBKR**: Postgres schema, bar store, Alpaca/Stooq/SEC EDGAR/FRED/Finnhub clients in `ai-trading/common/` (start from `ai-trading/market-data/`'s Alpaca and SEC clients), futures roll map, streaming-slot logic. The IBKR adapter follows the Phase 0 probe.
3. **Desk frontend shell** in `packages/family-desk/frontend` from the mockups, on fixture data.
4. **When IBKR approves the data user:** run Task 0.5 with the owner on a weekday in US regular hours, then Task 0.6.

## Decisions Already Made (do not reopen without the owner)

- **Strategy-first:** every alert and paper order comes from a user-owned, versioned strategy. There are no manual price alerts.
- **Strategy specs:** JSON, with Zod v4 in `ai-trading/contracts` as the source of truth, generating JSON Schema and then Pydantic. YAML was rejected (YAML 1.1 reads `15:55` as a number). The API re-validates every save.
- **Live data:** one IBKR data username, shared by both users across all ai-trading apps. The owner accepted the per-person licensing gray area.
- **History:** free sources (Alpaca historical bars since 2016, Stooq, SEC EDGAR, FRED, Finnhub).
- **Data budget:** at most $30 per month.
- **Paper trading:** IBKR paper, behind the paper guard (`DU` account prefix, the paper port, and a `paper` config).
- **Hostnames and layout:**
  - `trading.tobytran.dev` is the Desk; the hub moves to `trading-hub.tobytran.dev`, replacing `trading-static`.
  - Paper is a tab in the Desk under the same Clerk login.
- **Parked:** Desk v2 (automated live long-term trading) and Desk v3 (automated day trading, 1–10 trades a day). v1 must not block them (02a §15).

## Things the Next Session Should Know

- **Two lanes** (`AGENTS.md` Scope, from PR #77):
  - This is the Family Desk lane: `plans/subplans/02*.md`, the Paper mockups, and the Desk's own directories.
  - The open-source lane owns the hub, the upstream apps, and the hub's move to `trading-hub`. Phase 4 waits for that move; it does not redo it.
  - Do not edit the other lane's files. Keep edits to `plans/STATUS.md` and `AGENTS.md` small and additive.
  - The open-source lane's newest handoff is `plans/handoffs/*trading-hub*`.
- **Shared checkout.** Expense and ai-trading main sessions both work on `feature/toby` in the main checkout (root `../AGENTS.md`).
  - Stage exact paths only, and leave other sessions' changes alone.
  - Expense rules allow resetting and force-pushing `feature/toby` after a squash merge, which drops any unmerged ai-trading commits. Push often and get Desk work to `dev` quickly.
- **Delivery.**
  - Pull requests to `dev` must pass the required "Contracts, services, workers, frontends" check, and auto-merge is disabled. Use `gh pr checks <n> --watch`, then `gh pr merge <n> --squash`. Never pass `--delete-branch`, `--admin`, or force pushes.
  - The ruleset also requires the branch to be up to date with `dev`, and the expense CI takes about 15 minutes, so `dev` often moves during a run. When the merge says "not up to date", run `gh pr update-branch <n>`, wait for the checks again, then merge.
  - Bundle a phase's commits into one pull request to save CI cycles.
  - Commit messages are a single line with no trailer.
  - AGENTS.md's standing delivery authorization covers routine commits, pull requests, merges, scoped `main` releases, and deploys of a requested phase.
- **IBKR facts from the docs** (see 02d):
  - Two-factor login likely applies to paper logins too, so plan for a weekly Monday phone approval.
  - Streaming US stocks over the API needs the $4.50 add-on.
  - IBKR updates arrive every 250 ms (100 ms for options), not every tick.
  - Up to 32 API clients can connect to one gateway.
  - Pacing is 60 historical requests per 10 minutes.
- **VPS headroom** (read-only check): 6 vCPU, 11.4 GiB RAM with 9.4 GiB available, no swap, 35 GB of disk free. Phase 3 memory limits are in 02d check 6.
- **Paper MCP quirks** (for mockup edits):
  - Text nodes do not inherit font or color, so set `font-family: Inter` and a color on every text element.
  - `get_screenshot` often lags one write; take it twice.
  - Use `find_nodes` with `textValue` to locate text.
  - Call `finish_working_on_nodes` when done.
  - Mobbin search does not index Apple's Stocks app by name; Stake's screens are indexed.
- **Secrets.** Read and write only through `../common/config/family_config.py`. Never print values, and never keep `.env` files inside `ai-trading/`. For VPS access, follow `../infrastructure/gcp/family-config/install-reader-key.sh` (`with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY`) and keep commands read-only unless a phase deploys.
- **Upstream submodules** (`packages/*`): never edit them. The four upstream checkouts with full source live in `../.worktrees/ai-trading-hub/ai-trading/packages/`, a parallel session's worktree; read only. The main checkout's submodules are not initialized.
