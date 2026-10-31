# ADR-0005: IBKR Gateway back in, on the spare laptop

Status: accepted 2026-10-31 (owner), supersedes the 2026-10-29 gateway rejection. Source: [02t §1](../../plans/subplans/02t-market-data-bridge-plan.md).

Decision: IBKR Trader Gateway returns to the design as the free real-time source, running on the owner's **spare Ubuntu laptop** with a **daily on/off ritual the owner accepts**. It is a Python edge (`ibasync`) behind the bridge proto; **no MFA bypass is ever built** (the daily sign-in is the ritual). Owner-gated items: Gateway 10.50 install, data-user login + IBKR Mobile 2FA each trading morning, socket 4002, read-only API, trusted `127.0.0.1`, Tailscale link to the VPS, and the Monday 09:30 ET cron the owner answers by phone.

Consequences: B1 is the next bridge stage after B2; the edge is dark until the ritual exists; outside gateway hours the UI shows the honest "gateway off (expected)" state, never an error.
