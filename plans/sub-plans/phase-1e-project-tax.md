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

- [ ] Create `POST /api/v1/projects` — create a new project
- [ ] Create `GET /api/v1/projects` — list projects scoped to tenant
- [ ] Create `PATCH /api/v1/projects/{id}` — update project
- [ ] Create `DELETE /api/v1/projects/{id}` — soft-delete project
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

- [ ] Create `GET /api/v1/projects/{id}/tax-summary` endpoint:
  ```python
  from decimal import Decimal
  from typing import List
  from pydantic import BaseModel

  class CategoryDeductionSummary(BaseModel):
      category_name: str
      total_amount: Decimal
      deductible_amount: Decimal
      expense_count: int

  class MonthlyDeductionSummary(BaseModel):
      month: str  # "2025-01"
      total_amount: Decimal
      deductible_amount: Decimal

  class TaxSummaryResponse(BaseModel):
      project_id: str
      project_name: str
      tax_year: int
      total_expenses: Decimal
      total_deductible: Decimal
      category_summary: List[CategoryDeductionSummary]
      monthly_summary: List[MonthlyDeductionSummary]
  ```
- [ ] Export tax summary as CSV/PDF
- [ ] Support date range filtering (tax year, quarterly)

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/projects` | Create project |
| `GET` | `/api/v1/projects` | List projects |
| `GET` | `/api/v1/projects/{id}` | Get project details |
| `PATCH` | `/api/v1/projects/{id}` | Update project |
| `DELETE` | `/api/v1/projects/{id}` | Delete project |
| `GET` | `/api/v1/projects/{id}/tax-summary` | Tax deduction summary |
| `POST` | `/api/v1/projects/{id}/export` | Export project data |
| `POST` | `/api/v1/categories` | Create category |
| `GET` | `/api/v1/categories` | List categories |
| `PATCH` | `/api/v1/categories/{id}` | Update category |
| `DELETE` | `/api/v1/categories/{id}` | Delete category |

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
