# Handoff: Family Desk v1 (Phases 1c and 1d Done; Phase 2a Next)

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
- `plans/subplans/02f-desk-indicators-and-ai-daily-design.md`
- `plans/subplans/02g-desk-covered-calls-and-futures-swing-design.md`
- `plans/subplans/02h-desk-research-tools-design.md`

Paths below are relative to `ai-trading/` unless they start with `../`.

## Where Things Stand (updated 2026-10-10, night)

| Item | State |
|---|---|
| Design | Approved: `02a` (Desk v1) and `02b` (market data). `02` keeps only the base sections they still cite (§4.3, §6.3, §6.4, §6.6, §7, §8, §11, §12). Decisions are in `STATUS.md` (2026-10-10 rows). |
| Layout | `packages/family-desk/` (`contracts/`, `backend/`, and `frontend/` from Phase 4). Packages never import each other; code that two or more ai-trading packages share (provider clients, a shared schema, shared types) goes in `ai-trading/common/` (`AGENTS.md` "Our Code"). |
| Mockups | Paper file "TobyTest", page "Family Desk · R2 mockups": desktop D1–D19, mobile M2, M3, M5–M11. Indexed in `02a` §16. |
| Phase 0 spike | Tasks 0.1–0.4 done. The owner set up the IBKR data user (guide `plans/subplans/02e-ibkr-data-user-setup.md`, $14.50 a month) and is waiting for IBKR's approval. Tasks 0.5–0.6 wait on that. |
| Phase 1 strategy core | Done (PR #95). |
| Phase 1b ported quant core | Done ([phase-1b-ported-quant-core.md](../subplans/02c-desk-v1-tasks/phase-1b-ported-quant-core.md)): option math, covered-call math, the support/resistance level, and paper-order sizing. On `dev` (PR #104). Contracts 40 tests, backend 169. |
| Phases 1c and 1d | Done, on `dev` (PR #110, 2026-10-11): technicals, pivots, the Desk Technical Bias, futures specs, dates, and sizer; as-of helpers, valuation, earnings reaction, the backtest engine, AI call settlement. Backend 525 tests, contracts 47, none skipped. Built in parallel worktree lanes from tested prototypes. **Known open item:** a `bar_close_1h` signal in a session's truncated final bin fills at 16:30, not 16:00; Phase 6b fixes it first (02c). |
| Reuse | `02a` §11 maps what to copy from Vibe-Trading, ai-hedge-fund, and TradingAgents. TradingAgents was surveyed on 2026-10-10: its vendor router and typed errors, SEC EDGAR and FRED clients, and analyst and debate prompts are worth adapting; its LangGraph and LangChain code is not. |
| Indicators and AI daily | `02f`, approved with mocks D9–D12, M7, and M8 (2026-10-10). Flip-card indicators and the Desk Technical Bias (TradingView's published rules); consensus EPS from Eulerpool's free tier after a pilot; one Desk AI verdict per stock each trading day, with no budget cap. |
| Covered calls and futures swing | `02g`, approved with mocks D13–D16, M9, and M10 (2026-10-10). Covered-call coverage, rolls, and income; mini/micro futures swings for both users, with roll dates from CME's rules and a micro-first sizer. |
| Recon and plan | The recon of all four upstream apps rewrote the reuse map (02a §11, by phase). `02h` adds backtests, the AI track record, valuation and earnings reaction, and the holding timeline (mocks D17–D19, M11). `02c` is the comprehensive master plan (new pure Phases 1c and 1d, and Phase 6b). All three await the owner's review. |

## Next Steps, in Order

Each phase gets a task file under `plans/subplans/02c-desk-v1-tasks/` (writing-plans skill, written from a tested prototype in `temp/`), owner review, then subagent-driven execution in a `.worktrees/` worktree merged back into `feature/toby`, and one pull request to `dev`.

1. **Phase 2a plan, data without IBKR** (02c Phase 2): write the task file from a tested prototype, get the owner's review, then run it in parallel worktree lanes as for 1c and 1d. Then 3 → 4 → 5, 6, 6b → 7 (02c Execution Map). The open-source lane owns `ai-trading/market-data/`; move it into `common/` together with that lane, never alone.
2. **When IBKR approves the data user:** Task 0.5 with the owner (weekday market hours; also confirm that greeks arrive through the $4.50 add-on), Task 0.6, then Phase 2b (the IBKR client).

Done on 2026-10-10:
- PR #81 is closed.
- `temp/.env` moved to Firestore (`shared/ibkr` and `shared/alpaca`, linked from the new `ai-trading/desk`) and was deleted.

Still open: the Flex token and query ID are not in Firestore (Task 0.4 Step 4).

## Decisions Already Made (do not reopen without the owner)

- **Strategy-first:** every alert and paper order comes from a user-owned, versioned strategy. There are no manual price alerts.
- **Strategy specs:** JSON, with Zod v4 in `packages/family-desk/contracts` as the source of truth, generating JSON Schema and then Pydantic. YAML was rejected (YAML 1.1 reads `15:55` as a number). The API re-validates every save.
- **Live data:** one IBKR data username (a secondary username on an existing account), shared by both users across all ai-trading apps; the owner accepted the per-person licensing gray area. Subscribed: the $10 snapshot bundle plus the $4.50 streaming add-on; OPRA ($1.50) only if Task 0.5 shows it is needed.
- **History:** free sources (Alpaca historical bars since 2016, Stooq, SEC EDGAR, FRED, Finnhub). The data budget is at most $30 a month.
- **Paper trading:** IBKR paper, behind the paper guard (`DU` account prefix, the paper port, and a `paper` config).
- **Hostnames:** the hub moved to `trading-hub.tobytran.dev` (01l, live). `trading.tobytran.dev` becomes the Desk in Phase 4 (02a §8). Paper is a Desk tab under the same Clerk login.
- **Phase 1 and 1b rulings:** listed under "Decisions for Owner Review" in `phase-1-strategy-core.md` and `phase-1b-ported-quant-core.md`. Examples: rising-edge firing, VWAP over regular hours, option math on the standard library, coverable contracts per 100 shares, support/resistance from confirmed pivots, and sizing that returns a reason instead of an order.
- **Indicators and AI (02f):** one AI verdict with its panel inside, replacing the weekly persona review; no budget cap on that job; consensus EPS from Eulerpool's free tier after a pilot, with Finnhub plus Alpha Vantage free as the fallback.
- **Covered calls and futures (02g):** both users swing-trade mini and micro futures directionally; the covered-call score stays 02 §6.3's.
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
  - Paper drops `stroke-opacity` and `fill-opacity` (and opacity set through update_styles): use 8-digit hex alpha such as `#30D15880`.
  - The file-level token `--color-ai` (`#A78BFA`) is the Desk AI violet. The technical bias gauge is the group "Gauge · canonical" in D10; copy it rather than redrawing it.
- **Mobbin references:** the owner's Mobbin subscription ended 2026-10-11. The saved screens, findings, and specs live in the gitignored `temp/mobbin-refs/` and `temp/desk-research/`, on the owner's Mac only.
- **Secrets:** read and write only through `../common/config/family_config.py`. Never print values, and never keep `.env` files inside `ai-trading/`.
- **Upstream submodules** (`packages/*`): initialized in the main checkout; read only. Never edit them (Vibe-Trading's fork belongs to the open-source lane).
