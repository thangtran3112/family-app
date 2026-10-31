# ADR-0001: Provider mix

Status: accepted 2026-10-31 (owner). Source: market-data research, [02b §4](../../plans/subplans/02b-desk-market-data-options.md), [02t](../../plans/subplans/02t-market-data-bridge-plan.md).

Decision: build the Desk's market data on a mix of **IBKR Gateway + Alpaca + Longbridge**, with **marketdata.app ($30 delayed) as an options-only fallback**. **Never open a Tradier account** (its Python adapter stays dormant, in no default chain, not ported to the bridge).

Context: Alpaca is the proven free baseline (SIP stocks verified 200, paper account 200); IBKR is free on hardware the owner already owns; Longbridge is the cheap real-time-stocks candidate with a ~HK$22 OPRA add-on (US-resident OpenAPI eligibility still unverified); Tradier Pro ($10/mo real-time stocks+options) was recommended, then declined by the owner.

Consequences: the bridge router serves this exact ladder (options ladder IBKR → Longbridge → marketdata.app → Alpaca); marketdata.app stays disabled on the stocks row with an "Options only" reason; no Tradier keys ever.
