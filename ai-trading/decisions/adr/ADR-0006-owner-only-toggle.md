# ADR-0006: Provider toggle is owner-only

Status: accepted 2026-10-31 (Hermes ruling §11 Q6). Source: [02t §6 + §11](../../plans/subplans/02t-market-data-bridge-plan.md), mock XUL-2.

Decision: the Settings market-data card shows routing states to everyone, but **only the owner changes data providers**; the wife sees the same card read-only with "Only the owner changes data providers". Mobile shows read-only status rows (the Desk is desktop-first).

Consequences: identity stays the existing Clerk allow-list (no new auth system); a configured-but-down choice saves with the §6 warning ("Saved. IBKR is off right now, so Alpaca serves until it's back."); `422` reasons render inline under the row.
