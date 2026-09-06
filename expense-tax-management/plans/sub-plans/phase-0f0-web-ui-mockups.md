# Phase 0F0 — Web UI Mockup Preflight (Mobile-First)

> **Milestone**: 0 (Core Expense Management MVP)
> **Blocks**: Phase 0F (Web App UI) — no frontend implementation starts until 0F0 is ✅ Complete
> **Output dir**: `plans/mockups/` (committed, reviewed before code)
> **Estimated Effort**: 2-3 days

---

## Objective

Produce all relevant static mockups for Phase 0F **before** writing any `frontend/web` implementation code, so layout, IA, responsive behavior, and dark-mode aesthetic are agreed up front.

Rule going forward: **every frontend phase/task/sub-plan requires a mockup preflight** producing files under `plans/mockups/` first.

---

## Scope — Screens To Mock (mirrors Phase 0F § Page Structure)

1. `auth/` — `/login`, `/signup`, `/forgot-password`
2. `dashboard/` — `/` quick stats, recent expenses, quick actions, project summary
3. `upload/` — `/upload` camera capture, file picker, batch, processing status, review & confirm
4. `expenses-list/` — `/expenses` list/grid toggle, filters, search, bulk actions, sort, pagination
5. `expense-detail/` — `/expenses/[id]` receipt viewer, editable fields, category/project, tags, tax toggle, line items, history
6. `projects/` — `/projects`, `/projects/[id]`, tax summary, create/edit, export
7. `categories/` — `/categories` list, create/edit, stats
8. `settings/` — `/settings` profile, tenant, LLM config, monthly budget, currency, prompts, storage, export
9. `components/` — `ExpenseCard`, `ExpenseForm`, `ReceiptViewer`, `FileUploader`, `CategoryPicker`, `ProjectPicker`, `TagInput`, `StatusBadge`, `QuickFilter`, `TaxSummaryChart`, `DataTable`, `BottomNav`
10. `pwa-mobile/` — bottom nav, install banner, offline indicator, pull-to-refresh, swipe actions, camera crop guide

Each screen needs at minimum:
- `desktop-1440.png` (or `.html` interactive mock) + `mobile-375.png` (mobile-first is primary)
- dark-mode default; light-mode only if trivially free
- annotated states: loading skeleton, empty, error, offline where applicable

---

## Format & Location Convention

```
plans/mockups/
├── README.md                # this convention (index + review checklist)
├── auth/
├── dashboard/
├── upload/
├── expenses-list/
├── expense-detail/
├── projects/
├── categories/
├── settings/
├── components/
└── pwa-mobile/
```

- Prefer static exports: `.png` + optional interactive `.html` (no build step, open directly).
- File naming: `<screen>-<viewport>.<ext>`, e.g. `dashboard-mobile-375.png`, `upload-review-desktop-1440.png`.
- No generated assets committed except mockups + README (keep `node_modules`, `.next`, exports out).
- Source files (Figma links, Excalidraw, v0 chats) recorded as URLs in each folder's `NOTES.md`, not binary blobs.

---

## Inputs

- `plans/sub-plans/phase-0f-web-ui.md` — page structure, components, breakpoints, DoD
- Existing `frontend/web` shell (App Router, Tailwind v4 `@theme`, Radix) — mockups must respect current tokens/layout constraints
- TaxHacker reference patterns noted in 0F

## Outputs (Definition of Done)

- [ ] All 10 groups above have at least mobile-375 mock + desktop-1440 mock (or documented waiver with reason)
- [ ] Bottom nav + upload center action + camera crop guide mocked at 375px
- [ ] Loading / empty / error / offline states mocked for dashboard, expenses list, upload
- [ ] Tax summary chart + monthly LLM budget bar mocked with realistic numbers
- [ ] `plans/mockups/README.md` index updated with file list + review status
- [ ] Review pass recorded (reviewer, date, approved / changes requested)
- [ ] Phase 0F sub-plan header updated: `Dependencies: Phase 0F0 (mockups approved)`

---

## Non-Goals

- No `frontend/web` code changes in this phase (styles, components, routes all deferred to 0F).
- No API client generation, no SWR/TanStack wiring, no PWA manifest changes.
- No Figma-to-code automation — mockups are approval artifacts, 0F implements from them manually.

---

## Review Gate For Phase 0F

Phase 0F may start only when:
1. Every folder in `plans/mockups/` has its mocks + `NOTES.md` (or waiver).
2. `plans/mockups/README.md` checklist is fully checked.
3. This file's DoD is fully checked and PLAN.md flips 0F0 → ✅ Complete.
