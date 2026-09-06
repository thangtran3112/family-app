# Mockups — Web UI Preflight (Phase 0F0)

> All frontend implementation (Phase 0F+) is gated on mockups here being reviewed + approved.
> Source of truth for required screens: `../sub-plans/phase-0f0-web-ui-mockups.md`.

## Folder Index

| Folder | Screen / Route | Files (HTML interactive + 2 PNG renders) | Status |
|---|---|---|---|
| `auth/` | `/login`, `/signup`, `/forgot-password` | `auth.html` + `auth-mobile-375.png` + `auth-desktop-1440.png` | ✅ Draft |
| `dashboard/` | `/` stats, recents, quick actions, projects | `dashboard.html` + `dashboard-mobile-375.png` + `dashboard-desktop-1440.png` + skeleton state inline | ✅ Draft |
| `upload/` | `/upload` camera, picker, batch, progress, review | `upload.html` + `upload-mobile-375.png` + `upload-desktop-1440.png` | ✅ Draft |
| `expenses-list/` | `/expenses` list/grid, filters, search, bulk, sort | `expenses-list.html` + `expenses-list-mobile-375.png` + `expenses-list-desktop-1440.png` + empty/offline inline | ✅ Draft |
| `expense-detail/` | `/expenses/[id]` viewer, fields, tax, items, history | `expense-detail.html` + `expense-detail-mobile-375.png` + `expense-detail-desktop-1440.png` | ✅ Draft |
| `projects/` | `/projects`, `/projects/[id]`, tax summary, export | `projects.html` + `projects-mobile-375.png` + `projects-desktop-1440.png` | ✅ Draft |
| `categories/` | `/categories` list, form, stats | `categories.html` + `categories-mobile-375.png` + `categories-desktop-1440.png` | ✅ Draft |
| `settings/` | `/settings` profile, tenant, LLM, budget, export | `settings.html` + `settings-mobile-375.png` + `settings-desktop-1440.png` + 80%/100% budget states inline | ✅ Draft |
| `components/` | shared Radix components (card, pickers, charts, nav) | `components.html` + `components-mobile-375.png` + `components-desktop-1440.png` | ✅ Draft |
| `pwa-mobile/` | bottom nav, install banner, offline, pull-refresh, swipe | `pwa-mobile.html` + `pwa-mobile-mobile-375.png` + `pwa-mobile-desktop-1440.png` | ✅ Draft |

## Conventions

- Naming: `<screen>-<viewport>.<ext>`, e.g. `dashboard-mobile-375.png`.
- Dark mode default; mobile-375 is primary, desktop-1440 secondary.
- Each folder gets a `NOTES.md` with Figma/v0/Excalidraw source URLs + open questions.
- No code, no build artifacts — `.png` + optional standalone `.html` only.

## Review Checklist (gate for Phase 0F)

- [x] All folders have mocks (10 HTML + 20 PNG, 2026-09-06 draft)
- [x] Loading / empty / error / offline states covered (dashboard skeleton, list empty + offline bar, upload progress, settings budget alerts)
- [x] Bottom nav + upload action + camera guide at 375px (dashboard, pwa-mobile, upload)
- [x] Tax + LLM budget visuals with realistic data (projects tax summary, settings budget 64%/80%/100%)
- [ ] Human review approval — **pending your sign-off below**

**Review:** _pending_ — reviewer: ___, date: ___, verdict: ___

> Agent self-check 2026-09-06: dashboard mobile + desktop PNGs visually verified (bottom-nav ↔ sidebar switch correct, dark theme, badges). Remaining 18 PNGs rendered from the same verified HTML/CSS system — spot-check recommended during your review.
