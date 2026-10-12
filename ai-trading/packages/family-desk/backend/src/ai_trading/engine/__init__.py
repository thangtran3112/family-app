"""Phase 3 runtime (02c): tick-driven live evaluation over stored bars, the outbox (a signal's
`signals` row and its `alerts`/`deliveries` rows in one transaction), degraded-data detection, and
the card-back read model (02f section 3). No IBKR in this phase (D-c, PROTO-BRIEF.md section 5):
every bar_close_* cadence runs against Alpaca's delayed bars for stocks and never fires for
futures; `degraded.quality_for` is the one function 2b changes.
"""
