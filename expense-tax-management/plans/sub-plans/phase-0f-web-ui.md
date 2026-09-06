# Phase 0F — Web App UI (Mobile-First)

> **Milestone**: 1 (Core Expense Management MVP)
> **Dependencies**: Phase 0F0 (mockups in `plans/mockups/` reviewed + approved — NO frontend code before this gate), Phase 0C (OCR), 1D (Cloud Storage), 1E (Projects/Tax)
> **Estimated Effort**: 5-7 days (excludes 0F0 preflight)

---

## Objective

Build a mobile-first responsive web app with all MVP features accessible and usable on phone screens, following TaxHacker's UI patterns with our enhancements.

> **Preflight gate**: implement strictly from approved `plans/mockups/` (Phase 0F0). No new screens, routes, or component variants beyond what 0F0 approved — changes require a mockup update + re-review first.

---

## Design Principles

1. **Mobile-First**: Primary use case is scanning receipts on a phone
2. **Progressive Web App (PWA)**: Installable on phone home screen
3. **Touch-Friendly**: Large tap targets, swipe gestures for common actions
4. **Dark Mode**: Default dark theme (following TaxHacker aesthetic)
5. **Fast**: Optimistic updates, skeleton loading states

---

## Page Structure

### 1. Authentication Pages
- [ ] `/login` — Email + password login
- [ ] `/signup` — Registration form
- [ ] `/forgot-password` — Password reset flow

### 2. Dashboard (`/`)
- [ ] **Quick Stats Card**: Total expenses this month, top category, total deductible
- [ ] **Recent Expenses**: Last 10 expenses with thumbnails and status
- [ ] **Quick Actions**: Upload receipt (camera/file), create expense manually
- [ ] **Project Summary**: Active projects with expense totals

### 3. Expense Upload (`/upload`)
- [ ] **Camera Capture**: Direct camera access (mobile browser API)
- [ ] **File Upload**: Drag-and-drop (desktop) or file picker (mobile)
- [ ] **Batch Upload**: Upload multiple files at once
- [ ] **Processing Status**: Real-time progress indicator (OCR → Extracting → Done)
- [ ] **Review & Confirm**: Show extracted data, let user correct before saving

### 4. Expense List (`/expenses`)
- [ ] **List/Grid View Toggle**: List view for details, grid for visual scanning
- [ ] **Quick Filters**: Date range, category, project, status, amount range
- [ ] **Search Bar**: Full-text search with future semantic search
- [ ] **Bulk Actions**: Select multiple → categorize, tag, assign project, delete
- [ ] **Sort Options**: Date, amount, merchant, status
- [ ] **Infinite Scroll / Pagination**: Efficient loading for large datasets

### 5. Expense Detail (`/expenses/[id]`)
- [ ] **Receipt Viewer**: Pinch-to-zoom image viewer, PDF viewer
- [ ] **Extracted Data**: Editable fields (merchant, amount, date, items)
- [ ] **Category & Project**: Dropdowns for assignment
- [ ] **Tags**: Tag input with autocomplete
- [ ] **Tax Deduction**: Toggle + percentage slider
- [ ] **Line Items**: Expandable list of extracted items
- [ ] **History**: Processing history and edits
- [ ] **Similar Expenses**: (Future) Show related expenses from graph

### 6. Projects (`/projects`)
- [ ] **Project List**: Cards with expense count and total
- [ ] **Project Detail** (`/projects/[id]`): Expense list filtered by project
- [ ] **Tax Summary**: Deduction breakdown by category and month
- [ ] **Create/Edit Project**: Form with all project fields
- [ ] **Export**: Download CSV/PDF report

### 7. Categories (`/categories`)
- [ ] **Category List**: Manage categories with colors and icons
- [ ] **Create/Edit Category**: Form with name, color, icon, AI prompt
- [ ] **Category Stats**: Expense count and total per category

### 8. Settings (`/settings`)
- [ ] **Profile**: Name, email, avatar
- [ ] **Tenant Management**: Current tenant info ("Family"), tenant members, invite link, role assignment
- [ ] **LLM Configuration**: Provider selection (OpenRouter / OpenAI / PaddleOCR local endpoint), API keys, model picker
- [ ] **Monthly LLM Budget**:
  - Set monthly spending cap (USD)
  - Progress bar showing current spend vs. limit
  - Alert notifications configured at 80% and 100%
  - Monthly breakdown of token usage and costs by operation
- [ ] **Default Currency**: Base currency setting
- [ ] **Custom Prompts**: System prompt template customization
- [ ] **Storage**: Storage usage indicator
- [ ] **Export All Data**: Full data export (CSV + files ZIP)

---

## UI Components (Radix UI based)

- [ ] `ExpenseCard` — Compact expense display with thumbnail, merchant, amount
- [ ] `ExpenseForm` — Full expense edit form
- [ ] `ReceiptViewer` — Image/PDF viewer with zoom
- [ ] `FileUploader` — Drag-and-drop + camera capture
- [ ] `CategoryPicker` — Dropdown with color swatches
- [ ] `ProjectPicker` — Dropdown with project details
- [ ] `TagInput` — Multi-tag input with autocomplete
- [ ] `StatusBadge` — Processing status indicator
- [ ] `QuickFilter` — Compact filter chips
- [ ] `TaxSummaryChart` — Bar/pie chart for deduction breakdown
- [ ] `DataTable` — Sortable, filterable table for list views
- [ ] `BottomNav` — Mobile bottom navigation bar

---

## Mobile-Specific & PWA Features

- [ ] **PWA Manifest & Installation**:
  - `manifest.json` configured (`display: "standalone"`, icons 192/512px, splash screens)
  - Custom install banner and promotion modal
  - Service Worker registration for offline asset caching
- [ ] **Mobile Camera Scanning**:
  - Native file capture with environment camera preference (`<input type="file" accept="image/*" capture="environment">`)
  - Direct camera viewfinder modal using `navigator.mediaDevices.getUserMedia()` with receipt crop guide
- [ ] **Bottom Navigation**: Dashboard, Upload (prominent center action button), Expenses, Projects, Settings
- [ ] **Pull-to-Refresh**: Refresh expense list with tactile feedback
- [ ] **Swipe Actions**: Swipe expense row to quick-categorize or delete
- [ ] **Offline Indicator**: Inform user if offline and disable live AI queries gracefully

---

## Responsive Breakpoints

| Breakpoint | Screen | Layout |
|-----------|--------|--------|
| `< 640px` | Mobile | Single column, bottom nav, touch-optimized |
| `640-1024px` | Tablet | Two-column on some views, sidebar nav |
| `> 1024px` | Desktop | Full sidebar, multi-column layouts |

---

## Definition of Done

- [ ] All pages render correctly on mobile (375px width)
- [ ] Camera capture works on mobile browsers (Chrome, Safari)
- [ ] End-to-end flow works: upload receipt → OCR → review → save → view in list
- [ ] Projects and categories can be managed
- [ ] Basic search/filter works on expense list
- [ ] PWA manifest is configured and app is installable
- [ ] Dark mode is the default theme
- [ ] Page transitions are smooth (no layout shift)

---

## Notes

- Built with **Next.js 16+** and **React 19.2+** strictly as a **client-side presentation layer (PWA)**.
- All data queries and mutations consume FastAPI at `/api/v1/...` via typed client (`frontend/web/src/lib/api.ts`) generated from FastAPI `openapi.json`.
- State management and caching handled via SWR or TanStack Query.
- Styled with **Tailwind CSS v4.3+** (CSS-first engine with `@theme` block) and `@radix-ui/*` primitives.
- PWA powered by `@serwist/next` (official modern successor to next-pwa for App Router).
- Reference TaxHacker's component directory for UI patterns.
- TaxHacker uses `@dnd-kit` for drag-and-drop — useful for reordering.
- Chart library: `recharts` for tax summary charts.
