# Handoff: Family Desk v1 (Phase 1b Done, Phase 2 Next)

**Date:** 2026-10-10
**From:** the ai-trading main session that designed Desk v1 and ran Phases 1 and 1b
**For:** the next Desk-lane main session, started with the working directory `ai-trading/`
**Read first:**
- `../AGENTS.md` (shared checkout)
- `AGENTS.md`
- `plans/subplans/02a-desk-v1-strategies-design.md`
- `plans/subplans/02b-desk-market-data-options.md`
- `plans/subplans/02c-desk-v1-implementation-plan.md`
- `plans/subplans/02d-desk-spike-results.md`

Paths below are relative to `ai-trading/` unless they start with `../`.

## Where Things Stand (updated 2026-10-10, night)

| Item | State |
|---|---|
| Design | Approved: `02a` (Desk v1) and `02b` (market data). `02` keeps only the base sections they still cite (§4.3, §6.3, §6.4, §6.6, §7, §8, §11, §12). Decisions are in `STATUS.md` (2026-10-10 rows). |
| Layout | `packages/family-desk/` (`contracts/`, `backend/`, and `frontend/` from Phase 4). Packages never import each other; code that two or more ai-trading packages share (provider clients, a shared schema, shared types) goes in `ai-trading/common/` (`AGENTS.md` "Our Code"). |
| Mockups | Paper file "TobyTest", page "Family Desk · R2 mockups": desktop D1–D8, mobile M2, M3, M5, M6. Indexed in `02a` §16. |
| Phase 0 spike | Tasks 0.1–0.4 done. The owner set up the IBKR data user (guide `plans/subplans/02e-ibkr-data-user-setup.md`, $14.50 a month) and is waiting for IBKR's approval. Tasks 0.5–0.6 wait on that. |
| Phase 1 strategy core | Done (PR #95). |
| Phase 1b ported quant core | Done ([phase-1b-ported-quant-core.md](../subplans/02c-desk-v1-tasks/phase-1b-ported-quant-core.md)): option math, covered-call math, the support/resistance level, and paper-order sizing. Contracts 40 tests, backend 169. |
| Reuse | `02a` §11 maps what to copy from Vibe-Trading, ai-hedge-fund, and TradingAgents. TradingAgents was surveyed on 2026-10-10: its vendor router and typed errors, SEC EDGAR and FRED clients, and analyst and debate prompts are worth adapting; its LangGraph and LangChain code is not. |

## Next Steps, in Order

The owner's order: more mockups (done), port quant tools (done), Phase 2 data without IBKR, then the Desk frontend shell. Each phase gets a task file under `plans/subplans/02c-desk-v1-tasks/` (writing-plans skill, written from a tested prototype in `temp/`), owner review, then subagent-driven execution in a `.worktrees/` worktree merged back into `feature/toby`, and one pull request to `dev`.

1. **Phase 2 plan, without IBKR** (02c "Phase 2: Data foundation"):
   - `ai-trading/common/`: the provider layer (fallback chains, typed "no data" versus "provider unavailable" errors, as-of guards), Alpaca with a Stooq fallback, SEC EDGAR, FRED, and Finnhub;
   - the open-source lane's `ai-trading/market-data/` (on `dev` since #99) already has Alpaca and SEC clients for ai-hedge-fund: copy from it, or move it into `common/` together with that lane, never alone;
   - the Desk's Postgres schema, bar store, futures roll map, and streaming slots.
2. **Desk frontend shell plan** (02c Phase 4): `packages/family-desk/frontend`, a static Next.js app built from the mockups, on fixture data.
3. **When IBKR approves the data user:** run Task 0.5 with the owner on a weekday, 09:30–16:00 ET, with IB Gateway logged in; then Task 0.6 and the IBKR client.

Open questions for the owner: close the superseded docs PR #81? Remove `temp/.env` once its values are in Firestore (`AGENTS.md` forbids `.env` files inside `ai-trading/`)?

## Decisions Already Made (do not reopen without the owner)

- **Strategy-first:** every alert and paper order comes from a user-owned, versioned strategy. There are no manual price alerts.
- **Strategy specs:** JSON, with Zod v4 in `packages/family-desk/contracts` as the source of truth, generating JSON Schema and then Pydantic. YAML was rejected (YAML 1.1 reads `15:55` as a number). The API re-validates every save.
- **Live data:** one IBKR data username (a secondary username on an existing account), shared by both users across all ai-trading apps; the owner accepted the per-person licensing gray area. Subscribed: the $10 snapshot bundle plus the $4.50 streaming add-on; OPRA ($1.50) only if Task 0.5 shows it is needed.
- **History:** free sources (Alpaca historical bars since 2016, Stooq, SEC EDGAR, FRED, Finnhub). The data budget is at most $30 a month.
- **Paper trading:** IBKR paper, behind the paper guard (`DU` account prefix, the paper port, and a `paper` config).
- **Hostnames:** the hub moved to `trading-hub.tobytran.dev` (01l, live). `trading.tobytran.dev` becomes the Desk in Phase 4 (02a §8). Paper is a Desk tab under the same Clerk login.
- **Phase 1 and 1b rulings:** listed under "Decisions for Owner Review" in `phase-1-strategy-core.md` and `phase-1b-ported-quant-core.md`. Examples: rising-edge firing, VWAP over regular hours, option math on the standard library, coverable contracts per 100 shares, support/resistance from confirmed pivots, and sizing that returns a reason instead of an order.
- **Parked:** Desk v2 (automated live long-term trading) and Desk v3 (automated day trading, 1–10 trades a day). v1 must not block them (02a §15).

## Things the Next Session Should Know

- **Two lanes** (`AGENTS.md` Scope): this is the Desk lane (`plans/subplans/02*.md`, the Paper mockups, `packages/family-desk/`). The open-source lane owns the hub, the upstream apps, and `ai-trading/market-data/`; its newest handoff is `plans/handoffs/*trading-hub*`. Do not edit its files. Keep edits to `plans/STATUS.md` and `AGENTS.md` small and additive.
- **Shared checkout** (root `../AGENTS.md`): every main session works on `feature/toby` in the main checkout. Update it only with `git fetch origin && git merge origin/dev`; nobody resets, rebases, or force-pushes it. Stage exact paths only and leave other sessions' changes alone (for example a modified `packages/trading-agents` submodule or an untracked `../opencode.jsonc`).
- **Delivery:**
  - One pull request to `dev` per finished phase, from `feature/toby`. If `feature/toby` holds another lane's unmerged work, open it from a dedicated branch instead, as PR #95 did. Push to an open pull request only when its CI fails.
  - The required check is "Contracts, services, workers, frontends", and auto-merge is off. Use `gh pr checks <n> --watch`; when the branch falls behind `dev` (the expense CI takes about 15 minutes, so `dev` moves), run `gh pr update-branch <n>` and wait again; then `gh pr merge <n> --squash`. Never pass `--delete-branch` or `--admin`, and never force-push.
  - Commit messages are a single line with no trailer.
- **Subagents** (subagent-driven development): pool-sonnet for implementers, pool-terra for reviewers, `general` for the final review. pool-haiku, the `explore` agent, and the OpenCode Go pools were unavailable on 2026-10-10. The SDD `task-brief` script needs dotted task numbers (`1b.1`).
- **IBKR facts** (02d): two-factor login likely applies to paper logins too, so plan for a weekly phone approval; streaming US stocks over the API needs the $4.50 add-on; updates arrive every 250 ms (100 ms for options), not every tick; up to 32 API clients can connect to one gateway; pacing is 60 historical requests per 10 minutes.
- **VPS headroom** (read-only check): 6 vCPU, 11.4 GiB RAM with 9.4 GiB available, no swap, 35 GB of disk free. Phase 3 memory limits are in 02d check 6.
- **Paper MCP quirks** (for mockup edits):
  - Text nodes do not inherit font or color, so set `font-family: Inter` and a color on every text element.
  - `get_screenshot` often lags one write; take it twice.
  - Empty divs become Rectangles that cannot hold children.
  - Clone the desktop top bar and the mobile status bar from existing artboards (D1, M2) instead of redrawing them; move artboards with `update_styles` `left`/`top`.
  - Use `find_nodes` with `textValue` to locate text, and call `finish_working_on_nodes` when done.
  - Mobbin search does not index Apple's Stocks app by name; Stake's screens are indexed.
- **Secrets:** read and write only through `../common/config/family_config.py`. Never print values, and never keep `.env` files inside `ai-trading/`.
- **Upstream submodules** (`packages/*`): initialized in the main checkout; read only. Never edit them (Vibe-Trading's fork belongs to the open-source lane).
