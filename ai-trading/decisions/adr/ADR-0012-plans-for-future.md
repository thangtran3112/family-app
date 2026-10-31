# ADR-0012: `plans/` keeps future phases only

Status: accepted 2026-11-01 (owner). This cleanup phase.

Decision: `plans/` holds the tracker (`STATUS.md`), the defect ledger link, session handoffs (the live lanes read the newest per lane), and **only plans for future or in-flight work**. Completed phase detail leaves `plans/`: closed design series go to git history with a one-line STATUS row; durable choices move here as ADRs; delivery receipts sit in `changelog/`.

Consequences: the 2026-11-01 pass deleted the closed Release-1 series (`00*`, `01*`, `02i`) and compressed STATUS rows 0–3C to one-liners; `handoffs/` stays (AGENTS.md reads from it); all `02*` Desk plans stay untouched for the active lane; `decisions/` is now the authority for anything already decided — new plans link here instead of re-arguing.
