# Mockup Review 1

- Reviewed: 2026-09-06
- Scope: all 10 mockup groups, HTML sources, mobile/tablet/desktop PNG renders, `../sub-plans/phase-0f0-web-ui-mockups.md`, and `../sub-plans/phase-0f-web-ui.md`
- Verdict: **Superseded by discussion-approved architecture direction; written specification pending and non-executable**
- Handoff: this file remains historical evidence for the first combined-app review. Phase 0F0 is reopened and must produce separate Capture PWA, Office Web, and Foundry Web mockups.
- Rebaseline: `../sub-plans/phase-0i-polyglot-platform-rebaseline-design.md`
- Reference note: line numbers below snapshot the 2026-09-06 working tree. They are historical evidence, not stable links to current requirements.

## What Works

- Core MVP areas are represented: auth, dashboard, upload, expenses, detail, projects, categories, settings, shared components, and PWA flows.
- Mobile-first intent is visible. The 375px renders make receipt capture, upload, review, and offline behavior easy to understand.
- Dark surface palette, emerald primary action, amber warning, red destructive state, and compact card rhythm are coherent.
- Data feels realistic enough to exercise OCR, tax, duplicate, budget, and offline states.

## Approval Blockers

### P0: Define one authenticated app shell

Authenticated screens do not show one consistent navigation model. Dashboard has a desktop sidebar and mobile bottom nav; the other authenticated screens are standalone cards with no shell. Labels also disagree:

- Sidebar: `Dashboard`, `Upload`, `Expenses`, `Projects`, `Categories`, `Settings`
- Bottom nav: `Home`, `Upload`/`Scan`, `Bills`, `Plans`, `More`
- Phase 0F requirement: `Dashboard`, `Upload`, `Expenses`, `Projects`, `Settings`

Decision needed before implementation: use one route/label model and document which destinations are primary versus secondary. Recommended mobile nav: `Dashboard`, `Expenses`, center `Upload`, `Projects`, `Settings`; expose `Categories` from Expenses or Settings. Show shell behavior on every authenticated mockup, or explicitly mark shell as omitted from all page renders.

References: `dashboard/dashboard.html:6-7,16,33`, `pwa-mobile/pwa-mobile.html:17-20`, `../sub-plans/phase-0f-web-ui.md:119`.

### P0: State coverage is overstated

`README.md` marks loading, empty, error, and offline coverage complete, but several required states are absent or mixed into happy-path screens:

- Dashboard has a skeleton only. Add first-run empty, API error, retry, and offline states.
- Upload lacks camera permission denied, unsupported camera, invalid file, upload failure, OCR failure, retry, cancel/remove, duplicate, and offline queue states.
- Expenses list shows results, no-results, offline, and bulk selection simultaneously. Separate these into state frames. Add true zero-data empty state, pagination/infinite-scroll loading, and server error/retry.
- Auth needs distinct `/login`, `/signup`, and `/forgot-password` screens or annotated variants. Current file shows only login with an always-visible error.
- Detail needs missing receipt, failed processing, saving, save error, unsaved changes, delete confirmation, and delete undo states.
- Settings needs separate normal, 80%, and 100% budget variants. Current screen displays both alerts at once.

References: `README.md:28-38`, `auth/auth.html:20-25`, `dashboard/NOTES.md:3-5`, `upload/NOTES.md:3-5`, `expenses-list/expenses-list.html:18-31`, `settings/settings.html:22-24`.

### P0: Add tablet behavior

The plan defines `<640px`, `640-1024px`, and `>1024px` layouts. Every mockup currently switches from a narrow mobile layout directly to desktop at `1024px`. Add at least one 768px behavior annotation/render per shared shell and complex screen. Specify sidebar, top bar, two-column, and bottom-nav behavior at tablet widths.

References: `../sub-plans/phase-0f-web-ui.md:126-134`; each HTML file currently uses a single `@media(min-width:1024px)` breakpoint.

### P0: Replace emoji structural icons

Emoji currently carry navigation, status, category, action, and system meaning. Rendering varies by OS and cannot be tokenized or reliably labelled. The web package already includes `lucide-react`; use one SVG icon family with consistent stroke width and sizes. Keep emoji only as optional user-selected category content, not as navigation or control chrome.

References: all HTML files; especially `components/components.html:18-29`, `dashboard/dashboard.html:19,33`, `pwa-mobile/pwa-mobile.html:17-20`.

### P0: Define interaction and accessibility contracts

The mockups are visually useful but leave implementation-critical behavior undefined:

- Many actions are `div`, `span`, or text instead of buttons/links. Mark all tappable controls and cards with their intended role.
- Add visible `:focus-visible`, hover, pressed, disabled, loading, and selected states. Auth is the only mockup with a focus rule.
- Associate every label with a field. Specify `email`, `password`, `number`, `date`, `autocomplete`, required, and validation behavior.
- Give icon-only controls accessible names; do not rely on the visible emoji or color.
- Make toggle, slider, chips, sort headers, color swatches, and selection checkboxes keyboard and screen-reader operable.
- Keep interactive targets at least 44px high/wide, with at least 8px separation.
- Add error recovery beside the failed field or operation, not only a generic banner.

References: `auth/auth.html:12-13`, `expense-detail/expense-detail.html:8,13-16`, `components/components.html:20-29`.

### P1: Establish one shared fixture and reconcile numbers

Screens appear to describe one tenant and month, but values do not reconcile. Dashboard calls Dining the top category while Categories shows Groceries at `$612.40` and Dining at `$428.15`. Category totals also exceed dashboard September spend. Create one named mock fixture and reuse it across screens, or label each screen as an intentionally different scenario. This avoids implementation and review confusion.

### P1: Separate chart and data requirements from decoration

Project tax summary currently shows category bars only. The plan requires category and month breakdown. Add a month selector or month series, visible legend/data labels, empty/loading/error chart states, and a text/table alternative. DataTable needs `aria-sort`, responsive behavior, loading, empty, error, and pagination states.

References: `projects/projects.html:23-27`, `components/components.html:26-27`, `../sub-plans/phase-0f-web-ui.md:68-70,104-105`.

## Screen Review

| Area | Missing or ambiguous | Recommended handoff change |
|---|---|---|
| Auth | Signup/reset are described in a note but not rendered. No tenant creation/invite decision. Password visibility, reset success, verification, and retry are absent. Mobile has no brand mark. | Add route/state frames for login, signup, reset request, reset form, success, and error. Define whether signup creates a tenant or joins an invite. Add compact mobile branding. |
| Dashboard | Only skeleton is shown for loading. Fixed mobile nav can cover lower project content. Quick actions are not visibly interactive in HTML. | Add empty/error/offline states, reserve bottom safe-area space, and render actions as buttons with pressed/loading states. |
| Upload | Batch list says three files but review form does not show which file is selected or how to move between files. No per-file cancel/retry/remove. | Add selected-file indicator, previous/next review controls, queue actions, permission/error states, and duplicate resolution. |
| Expenses list | Grid toggle is static; filter/sort panel is static text. Empty state is rendered below populated rows. Bulk bar and empty content compete. No pagination/infinite-scroll frame. | Render separate list, grid, true empty, no-results, offline, loading-more, and bulk-action states. Add select-all/clear selection and delete confirmation/undo. |
| Expense detail | Line-items heading says four but only three rows are visible. Tax toggle has no off state. Delete is immediate-looking. | Show collapsed/expanded item behavior, explicit on/off toggle, save success/error, missing receipt, and destructive confirmation/undo. |
| Projects | `/projects` and `/projects/[id]` are combined into one static composition. No edit/archive, empty project, over-budget, no-budget, export progress, or export failure. Month tax breakdown is absent. | Split list/detail frames or label both panels as route states. Add lifecycle and export states; add month selector/series. |
| Categories | Mobile rows visibly concatenate name and metadata, e.g. `Groceries48 expenses`. Icon field is free text and stats are only inline totals. No delete/duplicate-name validation. | Add `.m b{display:block}` and `.m small{display:block;margin-top:2px}`. Use an accessible icon picker, validation, delete/archive confirmation, and a clearer stats treatment. |
| Settings | Monthly cap is displayed but not editable, alert thresholds are not configurable, and both alert scenarios are shown together. API-key lifecycle and provider test state are absent. | Add cap/threshold controls, provider validation/test result, show/hide/rotate key behavior, save/dirty/error states, invite success/expiry, and storage warning states. |
| Components | `ExpenseForm` is listed in `components/NOTES.md` but has no gallery example. DataTable, ReceiptViewer, BottomNav, and FileUploader show only a happy path. | Add ExpenseForm and state variants for every shared primitive before implementation. |
| PWA/mobile | Swipe actions are described but the screenshot does not reveal the action buttons. No undo snackbar, sync queue/conflict, install dismissed/unsupported, camera denied, or safe-area state. | Show an actual revealed swipe frame plus undo, queued sync, conflict, install, and permission states. Include safe-area and landscape behavior. |

## Styling Fixes

### Immediate mockup fixes

- Categories: make category name and metadata stack; current mobile and desktop renders visibly collide.
- PWA swipe: show the translated/revealed row with `Tag` and `Delete`; current overflow hides actions, so behavior cannot be reviewed.
- Expenses list: move no-results into its own state render; current sticky bulk bar sits above a contradictory no-results message.
- Dashboard: add enough bottom inset for the second project card to remain fully readable above fixed navigation.
- Detail: show fourth line item or a real expand/collapse affordance so `(4)` is not misleading.
- Auth: render default login separately from invalid-login error; the current primary screen looks broken by default.

### Shared visual system

- Replace repeated raw hex values with semantic tokens: `background`, `surface`, `surface-elevated`, `border`, `text`, `text-muted`, `primary`, `success`, `warning`, `danger`, and `info`.
- Define one spacing scale based on 4/8px increments, one radius scale, one shadow/elevation scale, and icon tokens such as 16/20/24px.
- Raise supporting text from mostly 10-12px to at least 12-13px; keep controls and primary body copy at 16px where mobile input zoom/readability matters.
- Use `font-variant-numeric: tabular-nums` for amounts, percentages, budgets, and table columns.
- Reduce card nesting. Use cards for real grouping; use section dividers or plain surfaces for lists to reduce visual heaviness.
- Use one primary CTA per screen. Make export, edit, invite, and delete clearly secondary/danger actions.
- Add consistent focus rings and pressed states without changing layout bounds.
- Use `min-height:100dvh`, `env(safe-area-inset-bottom)`, and a documented z-index scale for fixed navigation and bulk actions.
- Keep intentional horizontal chip scrolling, but add a visible scroll affordance and ensure clipped labels remain discoverable.
- Replace the Bitcoin glyph in the brand mark unless ExpenseTax is intentionally a crypto product; it currently communicates the wrong domain.

## Recommended Review Sequence

1. Decide shared shell, route labels, and tablet behavior.
2. Create shared fixture data and state matrix.
3. Add missing route/state frames, especially auth, upload failures, list states, detail mutations, and PWA recovery.
4. Apply icon, token, typography, control, safe-area, and card-hierarchy fixes.
5. Re-render all PNGs at 375px, 768px, and 1440px. Check portrait and landscape.
6. Update `README.md`, each `NOTES.md`, `../sub-plans/phase-0f0-web-ui-mockups.md`, and the review verdict only after those checks pass.

## Sign-off Checklist

- [x] Shared navigation labels and route map aligned in mockups.
- [x] Auth route coverage and tenant onboarding questions documented.
- [x] Required loading, empty, error, offline, and recovery states represented or annotated.
- [x] Tablet behavior documented and rendered at 768px.
- [x] Structural emoji removed from mockup controls and navigation; implementation should use Lucide/SVG icons.
- [x] Accessibility, focus, touch target, safe-area, and reduced-motion rules added to `mockup.css`.
- [x] Fixture totals reconciled for dashboard/category monthly spend.
- [x] Categories collision, PWA swipe visibility, bottom-nav inset, list contradictory state, and detail line-item count fixed.
- [x] PNGs regenerated and spot-checked at 375px, 768px, and 1440px.
- [ ] Human reviewer approves viewport strategy and remaining route/state decisions.

## Fix Handoff

### Applied Changes

- Added `mockup.css` shared tokens, focus-visible states, touch sizing, reduced-motion handling, safe-area insets, numeric alignment, authenticated sidebar, and mobile/tablet bottom navigation.
- Added explicit 640px tablet behavior to all 10 HTML mockups. Laptop layouts remain reporting/review-oriented at 1440px.
- Aligned authenticated navigation labels to `Dashboard`, `Upload`, `Expenses`, `Projects`, `Settings`; `Categories` remains secondary in the sidebar.
- Added app-shell navigation to upload, expenses, detail, projects, categories, and settings mockups.
- Added auth route cards for signup and forgot-password recovery.
- Added upload permission recovery, selected batch item context, and per-viewport capture/review guidance.
- Reordered laptop upload layout so batch review and correction lead; camera remains primary on mobile/tablet.
- Added expenses pagination, alternate no-results state, clearer offline state, and laptop bulk-review guidance.
- Added detail download controls, four visible line items, explicit tax percentage bounds, save/delete recovery guidance, and warranty/report language.
- Added project monthly tax breakdown, CSV/PDF export controls, and export/over-budget recovery guidance.
- Fixed category metadata stacking and converted color swatches into labelled controls.
- Added settings monthly cap, alert threshold, provider test/rotation, save/discard controls, and separate 80%/100% state language.
- Added the missing `ExpenseForm` component mock and expanded status variants.
- Made PWA swipe actions visibly revealed, added undo/sync recovery states, and aligned bottom-nav labels.
- Removed structural emoji from controls, navigation, headings, and data status examples; user category content can still be represented by text/icon labels.
- Added local `favicon.svg` so standalone mockups load without console noise.
- Reconciled monthly category totals to dashboard September spend: `$1,284.56`; Groceries is now top category.
- Updated `README.md`, all folder `NOTES.md` files, `../sub-plans/phase-0f0-web-ui-mockups.md`, `../sub-plans/phase-0f-web-ui.md`, and `../PLAN.md` with mobile/tablet/laptop intent.

### Viewport Contract

| Viewport | Primary use | Design priority |
|---|---|---|
| Mobile 375px | Immediate receipt capture and quick correction | Camera/FAB, one-column queue, offline capture, no hidden content behind nav |
| Tablet 768px | Capture plus batch review | Two-column review where useful, touch targets, bottom nav, landscape-safe layout |
| Laptop 1440px | Warranty lookup, tax review, reporting, export | Sidebar, dense list/table, category/month tax data, CSV/PDF actions |

### Remaining Before Phase 0F Code

- Static HTML still represents behavior; implementation must turn route cards, recovery notes, toggles, filters, sort controls, and export buttons into real interactions.
- Static controls use text labels as portable placeholders. Production UI should use the planned Lucide/SVG icon family with accessible names.
- Human must approve shared shell, tenant onboarding behavior, exact auth route split, and whether alternate states become separate PNGs or Storybook/state fixtures.
- Re-run final implementation review after frontend routes exist; this handoff does not claim application behavior is implemented.

### Verification Evidence

- Structural acceptance check passed for all 10 HTML files: shared stylesheet, 640px breakpoint, PWA revealed swipe state, and authenticated shell coverage.
- Regenerated 30 PNGs: 10 screens x 3 viewports (`mobile-375`, `tablet-768`, `desktop-1440`).
- `git diff --check` passed with no whitespace errors.
- Working tree changes are limited to mockup sources, viewport renders, planning/notes, and this handoff.
