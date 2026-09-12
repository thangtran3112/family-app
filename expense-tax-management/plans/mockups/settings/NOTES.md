# settings — NOTES (Phase 0F0, Superseded)

Current `settings.html` is rejected for mixing tenant controls with platform administration. Retain it only as historical input.

Replacement responsibilities:

- Capture PWA: minimal profile, active Personal/business context, current forwarding address, verified sender status, curated OCR modes, and remaining usage.
- Office Web core: tenant members, Personal/business memberships, default currency, data export, forwarding-token rotation, quarantine/history, plan/add-on status, and read-only AI usage.
- Office Web later feature gates: connected-mailbox configuration and premium AI-search controls.
- Foundry Web: provider credentials/references, raw models, curated mode routing, per-tenant model/operation quotas, internal cost controls, health, and audit.

Tenant users must not see provider API keys, raw model IDs, route controls, arbitrary system prompts, or editable dollar cost caps.

Sources:
- Source: local `settings.html` (standalone, no build step) + `-mobile-375.png` / `-desktop-1440.png` renders (Playwright, 2026-09-06)

Review source: `../../sub-plans/phase-0i-polyglot-platform-rebaseline-design.md`. No implementation starts until written approval.
