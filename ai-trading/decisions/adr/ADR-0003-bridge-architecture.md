# ADR-0003: Independent Go market-data bridge

Status: accepted 2026-10-31 (owner + Hermes 12-ruling review). Source: [02t](../../plans/subplans/02t-market-data-bridge-plan.md) + rulings §11.

Decision: market data is an **independent backend service — a Go module speaking gRPC with Connect unary JSON on the same port** — that wraps whichever provider serves a data class. The Desk frontend gets an owner-only provider toggle; the Desk backend reaches the bridge through the registry, never by importing provider code.

Review rulings that hold: the IBKR edge runs in Python (`ibasync`) *behind* the bridge proto; the Python↔bridge seam is Connect unary JSON (no new Python deps); bridge lives at `packages/market-data/bridge/` with the 01m facade untouched; ~~`trades`/`universe` stay direct Python~~ (**reversed 2026-11-01 by 02u §9 ruling 1**: `universe` moves at C1 and `trades` at P1; two adapters for one vendor drifted — the 5U fix landed in Python only); the Python `marketdata_app` adapter is deleted only after Go parity; Tailscale sidecar + Terraform ACL link the VPS to the laptop edge; the stocks toggle ships before option chains.

Consequences: stages B0–B7 in [02t §7](../../plans/subplans/02t-market-data-bridge-plan.md); B0 deployed dark; 02a's paper-orders doc is superseded; family-scoped routing row approved.
