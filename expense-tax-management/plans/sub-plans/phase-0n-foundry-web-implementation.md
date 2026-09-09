# Phase 0N: Foundry Web

Delivered `frontend/foundry-web` from approved Foundry gate: Next 16/React
19, ≥1024 platform shell, providers/models/immutable modes, aggregate/model
quota periods, reconciliation queue with dual-approval language, provider
calls, audit, separate platform login. Customer content is forbidden.

Owning-contract amendment: added service reads for current quota periods,
provider-call telemetry, reconciliation queue, and Foundry audit. Catalog
manager and quota reconciler guards remain non-inheriting. Typed generated
client wraps these reads. Identity remains deployment-gated; no token is
compiled. Standalone Docker/compose port 7303.
