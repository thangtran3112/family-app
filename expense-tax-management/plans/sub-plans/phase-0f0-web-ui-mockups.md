# Phase 0F0 - Three-Application UI Mockup Preflight

> **Status**: Reopened by Phase 0I architecture rebaseline; not ready to execute
> **Depends on**: Written approval of Phase 0I, then each application's implemented owning contracts
> **Blocks**: Each gate blocks only its matching Phase 0F Capture, Phase 0M Office, or Phase 0N Foundry implementation
> **Output**: Reviewed static mockups under `plans/mockups/rebaseline/`

Gate dependencies:

- Capture gate: revised Phases 0C and 0P.
- Office core gate: revised Phases 0E and 0P plus Phase 0J1.
- Foundry gate: Phase 0K.

## 1. Objective

Replace the rejected combined responsive application with three explicit products before frontend implementation:

- Capture PWA for phone/tablet receipt intake and quick correction.
- Office Web for laptop ledger, business, project, tax-preparation, search, and export work.
- Foundry Web for laptop-only authorized platform staff AI operations.

Existing mockups under `plans/mockups/` remain historical visual input. Their 2026-09-06 structural checks do not approve routes, ownership, controls, or responsive behavior for this architecture.

## 2. Design Source

Mockups must implement only written-approved contracts and boundaries from [Phase 0I](phase-0i-polyglot-platform-rebaseline-design.md), especially:

- Customer domain and authorization: sections 8 and 17.
- Plans and Foundry quotas: sections 10 and 11.
- Forwarding and connected mailboxes: sections 12 and 13.
- AI search: section 14.
- Frontend boundaries: section 15.

If a core interaction lacks an implemented contract, stop and amend its owning phase before designing around an assumption. Later premium/search interactions receive feature-specific mockup gates described in section 8.

## 3. Output Structure

```text
plans/mockups/rebaseline/
|-- README.md
|-- capture/
|-- office/
|-- foundry/
`-- shared/
```

Each screen includes standalone HTML or another reviewable source, required viewport PNGs, state variants, and a short `NOTES.md` recording decisions and unresolved questions.

## 4. Capture PWA Matrix

Required viewports: 375px mobile and 768px tablet. Desktop rendering is optional documentation, not a supported workflow.

Required screens and states:

1. Authentication, tenant entry, and active Personal/business profile selection.
2. Camera capture, file picker, permission recovery, invalid-file handling, and direct-upload progress.
3. Offline queue, reconnect, deduplicated retry, cancellation, and storage/OCR failure recovery.
4. Quick extraction review with explicit profile, optional same-business project, spending category, and tax-review handoff.
5. Curated Fast/Balanced/High Accuracy modes, remaining usage, UTC reset date, exhausted mode, permitted alternative, and manual fallback.
6. Current-profile forwarding address, copy/rotate handoff, verified-sender status, recent intake, quarantine notification, and no-credit quarantine state.
7. Minimal profile/account controls and Office Web handoff.

Capture must not show dense dashboards, tax reports, export builders, connected-mailbox administration, provider credentials, raw model IDs, route versions, prompt editors, or editable dollar cost controls.

## 5. Office Web Matrix

Required viewports: 1024px minimum and 1440px primary. Widths below 1024px show a Capture PWA handoff rather than compressing dense workflows.

Required screens and states:

1. Authentication and active Personal/business profile selection.
2. Dashboard with profile-scoped totals, processing, review, and quota status.
3. Dense expense ledger, exact filters, bulk review, pagination, and empty/error states.
4. Expense detail with receipt, provenance, corrections, spending category, same-business project, and business-only tax treatment.
5. Personal profile membership and business profiles with owner/editor/viewer role variants.
6. Project/client cost analysis without project tax identity.
7. Separate spending-category and versioned tax-category views.
8. Business/year tax preparation, review flags, reports, deterministic export preview, immutable snapshot history, and adapter download states.
9. Verified senders, forwarding-token rotation, forwarded-intake history, and quarantine review.
10. Tenant plan, add-ons, aggregate usage, and role-appropriate administration, including labels for later premium mailbox/search availability without unimplemented workflow controls.

Office tenant settings must not expose provider secrets, raw models, route controls, arbitrary prompts, provider health, or platform quota overrides.

## 6. Foundry Web Matrix

Required viewport: 1440px primary, 1024px minimum. No mobile operator workflow is required.

Required screens and states:

1. Separate platform operator/quota reconciler authorization, tenant-token rejection, non-inheriting endpoint permissions, and unauthorized-role response.
2. Provider connection list, health, write-only credential update, masked metadata, and Secret Manager failure.
3. Model catalog, capabilities, enabled/disabled state, and provider availability.
4. Curated mode route versions with immutable history and one active metered model per mode for MVP.
5. Tenant operation-aggregate and operation/model quota policies, current periods, reservations, explicit overrides, and mode-switch-proof trial usage.
6. Reservation detail covering reserved, call-started, consumed, released, and reconciliation-required states.
7. Provider-call latency, token, cost, acceptance, error, reconciliation evidence, deadline/escalation, and dual-approval resolution telemetry.
8. Audit history for credential, route, quota, and override changes.

Foundry screens may show tenant identifiers and operational aggregates only. They must never show receipt images, MIME, OCR text, line items, search text, or tax data.

## 7. Shared State Requirements

Every applicable screen set includes distinct frames for:

- Loading, first-run empty, populated, no-results, validation error, service outage, retry, and unauthorized states.
- Tenant owner/admin/member and Personal/business owner/editor/viewer capability differences.
- Business-only invitee denied Personal access.
- Stale entitlement synchronization, plan downgrade, quota exhaustion, and admitted in-flight job behavior.
- Optimistic update rollback and duplicate idempotent submission.
- Keyboard focus, visible labels, touch targets, contrast, reduced motion, and screen-reader names.

## 8. Future Feature Mockup Gates

Later phases must add and approve mockups before implementing their frontend surface:

- Revised Phase 3D: mailbox setup bound to one Personal/business profile, non-overlapping label/folder rules, zero/multiple-match review, entitlement loss, paused schedule, and scan history.
- Revised Phase 6A: Office keyword full-text and advanced-search controls plus no-results/error states; baseline exact filters/pagination already belong to 0J/0M.
- Revised Phases 6B/6C: Office semantic/natural-language search, trial 20/month, aggregate/model quota exhaustion, reconciliation, and non-AI fallback.
- Revised Phase 9C: authorized graph-search controls and provenance.

These future gates extend Office Web after its core Phase 0M approval. They do not block Phase 0F, 0M, or 0N.

## 9. Non-Goals

- No frontend application code, routes, generated clients, service workers, or production components.
- No invention of APIs, roles, plan rules, tax filing, or provider controls absent from approved upstream contracts.
- No requirement to retrofit legacy combined-app renders into the new folder structure.
- No dedicated native mobile design; Milestone 12 remains deferred.

## 10. Approval Gates

Shared checks apply to each application gate:

- [ ] Role/capability frames prove business-only users cannot access Personal records.
- [ ] Loading, first-run empty, validation error, unauthorized, service outage, and recovery states cover applicable screens.
- [ ] UI exposes no control owned by another application/service boundary.
- [ ] Keyboard focus, labels, touch targets, contrast, reduced motion, and screen-reader names are reviewed.

Phase 0F Capture gate:

- [ ] Capture PWA matrix reviewed at 375px and 768px.
- [ ] Forwarding address, sender verification, intake history, quarantine, and token-rotation handoff are represented.
- [ ] Offline queue, direct upload, quick review, quota exhaustion, alternatives, and manual fallback are represented.
- [ ] Capture review record names reviewer, date, verdict, and remaining decisions.

Phase 0M Office core gate:

- [ ] Office Web matrix reviewed at 1024px and 1440px, including small-screen handoff.
- [ ] Spending and tax categories are visibly separate; projects never appear as tax entities.
- [ ] Tenant settings contain no provider/model/prompt/operator controls.
- [ ] Tax screens say preparation/export and contain no filing action or claim.
- [ ] Office review record names reviewer, date, verdict, and remaining decisions.

Phase 0N Foundry gate:

- [ ] Foundry Web matrix reviewed at 1024px and 1440px.
- [ ] Quota frames show tenant aggregate plus model ceilings and ambiguous-call reconciliation.
- [ ] Receipt, MIME, OCR, search text, and tax content never appear.
- [ ] Foundry review record names reviewer, date, verdict, and remaining decisions.

Each application may be approved independently. Phase 0F requires Capture plus shared checks; Phase 0M requires Office plus shared checks; Phase 0N requires Foundry plus shared checks.
