# Phase 6A — SQL Filtering & Full-Text Search

> **Milestone**: 3 (Search & AI Query)
> **Dependencies**: Milestone 0 (MVP)
> **Estimated Effort**: 2-3 days

---

## Objective

Implement robust exact-match filtering and PostgreSQL full-text search for structured expense queries.

---

## Tasks

### 1. Structured Filters

- [ ] Implement filter API: `GET /api/v1/expenses?filters=...` (strictly scoped to user's `tenantId`)
- [ ] Supported filters:
  | Filter | Type | Example |
  |--------|------|---------|
  | `dateFrom` / `dateTo` | Date range | `2025-01-01` to `2025-12-31` |
  | `amountMin` / `amountMax` | Number range | `10.00` to `500.00` |
  | `categoryId` | UUID | Single or multiple categories |
  | `projectId` | UUID | Single or multiple projects |
  | `status` | Enum | `COMPLETED`, `REVIEW`, `PENDING` |
  | `source` | Enum | `MANUAL`, `EMAIL`, `MANUAL_AND_EMAIL` |
  | `merchant` | String (partial) | `costco`, `amazon` |
  | `tags` | String[] | `["electronics", "home"]` |
  | `isTaxDeductible` | Boolean | `true` |
  | `currency` | String | `USD`, `CAD` |
- [ ] Support AND/OR logic for combining filters
- [ ] Pagination with cursor-based pagination (for infinite scroll)
- [ ] Sort options: date (default), amount, merchant, createdAt

### 2. Full-Text Search (PostgreSQL tsvector)

- [ ] Create `tsvector` column on `expenses` table
- [ ] Build search vector from: `title + description + merchant + ocrRawText + tags`
- [ ] Create GIN index on search vector
- [ ] Implement trigger to auto-update tsvector on insert/update
- [ ] Create search API: `GET /api/v1/expenses/search?q=...`
- [ ] Support `ts_rank` for relevance scoring
- [ ] Support phrase search with `phraseto_tsquery`

### 3. Combined Search + Filter

- [ ] Allow combining text search with structured filters
  - Example: Search "fridge" + filter by project "Home Office" + date 2025
- [ ] Optimize query plan with proper indexes

---

## Definition of Done

- [ ] All structured filters work individually and in combination
- [ ] Full-text search returns relevant results with ranking
- [ ] Search + filter combination works (e.g., "fridge" in "Home Office" project)
- [ ] Query performance < 200ms for 10K+ expenses
- [ ] UI filter panel updates expense list in real-time
