# ADR-0009: Dual-agent post-phase walkthrough

Status: standing rule (owner, 2026-10-31). Source: `STATUS.md` header, [02t §7](../../plans/subplans/02t-market-data-bridge-plan.md).

Decision: after every major phase completes, **both Hermes and Claude Code walk the Desk frontend end to end** (Claude Code drives the browser over CDP; Hermes orchestrates and compares against the Paper mocks with 30-second pauses between drives). All findings go into one defect ledger (`DEFECTS.md`) before any fix wave starts; fix the class, not the site; re-walk after backend-only stages over the status bar, Settings, and every stamped screen.

Consequences: the market-data phase walkthrough caught D-073..D-076 in exactly this gate; every rollout stage's exit gate names the walkthrough.
