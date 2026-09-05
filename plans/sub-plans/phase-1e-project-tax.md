# Phase 1E — Project & Tax Deduction Management

> **Milestone**: 1 (Core Expense Management MVP)
> **Dependencies**: Phase 1B (Data Model)
> **Estimated Effort**: 2-3 days

---

## Objective

Enable users to create business projects and attribute expenses for tax deduction tracking, with AI-assisted project attribution.

---

## Features

### 1. Project CRUD

- [ ] Create `POST /api/projects` — create a new project
- [ ] Create `GET /api/projects` — list projects scoped to tenant
- [ ] Create `PATCH /api/projects/:id` — update project
- [ ] Create `DELETE /api/projects/:id` — soft-delete project
- [ ] Project fields:
  - Name, description, color, icon
  - Business type (LLC, S-Corp, Sole Proprietorship, etc.)
  - Tax year
  - Active/inactive toggle
  - Custom AI prompt for auto-attribution

### 2. Category Management

- [ ] Create CRUD APIs for categories (similar to TaxHacker)
- [ ] Seed default categories:
  - Office Supplies, Travel, Meals & Entertainment, Vehicle, Utilities
  - Insurance, Professional Services, Advertising, Equipment, Home Office
  - Software & Subscriptions, Repairs & Maintenance, Other
- [ ] Support custom AI prompt per category
- [ ] Color and icon for visual distinction

### 3. Expense ↔ Project Attribution

- [ ] Allow assigning an expense to a project via UI and API
- [ ] Support bulk assignment (select multiple expenses → assign to project)
- [ ] AI-assisted project suggestion:
  - When processing receipt, suggest which project based on merchant/items
  - Use project's custom AI prompt if set
  - Consider historical patterns (e.g., "Costco expenses usually go to Project X")
- [ ] Allow splitting an expense across multiple projects (future enhancement)

### 4. Tax Deduction Tracking

- [ ] Mark expenses as tax deductible (boolean flag)
- [ ] Set deduction type:
  - Business expense (100%)
  - Home office (% based on square footage)
  - Vehicle (mileage-based or actual expenses)
  - Mixed use (custom %)
- [ ] Set deduction percentage (0-100%)
- [ ] Calculate deductible amount: `amount * (taxDeductionPercent / 100)`
- [ ] Per-project deduction summary:
  - Total expenses
  - Total deductible amount
  - Breakdown by category
  - Breakdown by month/quarter

### 5. Tax Report / Summary

- [ ] Create `GET /api/projects/:id/tax-summary` endpoint:
  ```typescript
  interface TaxSummary {
    projectId: string;
    projectName: string;
    taxYear: number;
    totalExpenses: number;
    totalDeductible: number;
    categorySummary: {
      categoryName: string;
      totalAmount: number;
      deductibleAmount: number;
      expenseCount: number;
    }[];
    monthlySummary: {
      month: string; // "2025-01"
      totalAmount: number;
      deductibleAmount: number;
    }[];
  }
  ```
- [ ] Export tax summary as CSV/PDF
- [ ] Support date range filtering (tax year, quarterly)

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/projects` | Create project |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Get project details |
| `PATCH` | `/api/projects/:id` | Update project |
| `DELETE` | `/api/projects/:id` | Delete project |
| `GET` | `/api/projects/:id/tax-summary` | Tax deduction summary |
| `POST` | `/api/projects/:id/export` | Export project data |
| `POST` | `/api/categories` | Create category |
| `GET` | `/api/categories` | List categories |
| `PATCH` | `/api/categories/:id` | Update category |
| `DELETE` | `/api/categories/:id` | Delete category |

---

## Definition of Done

- [ ] User can create, edit, and delete projects
- [ ] User can create custom categories with colors/icons
- [ ] Expenses can be assigned to a project
- [ ] Tax deduction percentage can be set per expense
- [ ] Tax summary report shows totals by category and month
- [ ] Default categories are seeded on new user signup
- [ ] CSV export of project expenses works

---

## Notes

- TaxHacker has similar Project and Category concepts — reference their UI patterns
- Tax deduction logic is US-focused initially; may need localization later
- Consider IRS Schedule C categories as defaults for US users
