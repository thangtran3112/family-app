# Phase 6C — AI Query Interface (LLM-Powered)

> **Milestone**: 3 (Search & AI Query)
> **Dependencies**: Phase 6A (SQL), 3B (Semantic)
> **Estimated Effort**: 3-4 days

---

## Objective

Enable natural language queries like _"How much did I spend on office supplies last quarter?"_ or _"Find my Costco receipt for the Hisense fridge from 2025"_ — the LLM translates user intent into structured search across all search layers.

---

## Architecture

```
User: "What were my top 5 largest business expenses in Q2 2025?"
         │
         ▼
┌────────────────────────┐
│  LLM Query Planner     │   Translate NL → structured query plan
│  (function calling)     │
└────────┬───────────────┘
         │ returns:
         │ {
         │   sql_filters: { dateFrom: "2025-04-01", dateTo: "2025-06-30",
         │                  isTaxDeductible: true },
         │   sort: { field: "amount", order: "desc" },
         │   limit: 5,
         │   semantic_query: null,
         │   graph_query: null
         │ }
         ▼
┌────────────────────────┐
│  Search Orchestrator   │   Dispatch to appropriate search layers
│  ├─ SQL Filter (3A)    │
│  ├─ Semantic (3B)      │
│  └─ Graph (4C, future) │
└────────┬───────────────┘
         │
         ▼
┌────────────────────────┐
│  LLM Response Builder  │   Format results into natural language
└────────────────────────┘
         │
         ▼
"Your top 5 largest business expenses in Q2 2025 were:
 1. MacBook Pro - $2,499 (Jun 15, Electronics)
 2. Office furniture - $1,200 (Apr 3, Office Supplies)
 ..."
```

---

## Tasks

### 1. Query Planner (LLM with Function Calling)

- [ ] Design function schema for search dispatch:
  ```python
  from decimal import Decimal
  from typing import List, Optional, Literal
  from pydantic import BaseModel

  class SqlFilters(BaseModel):
      date_from: Optional[str] = None
      date_to: Optional[str] = None
      amount_min: Optional[Decimal] = None
      amount_max: Optional[Decimal] = None
      category_ids: Optional[List[str]] = None
      project_ids: Optional[List[str]] = None
      tags: Optional[List[str]] = None
      merchant: Optional[str] = None
      is_tax_deductible: Optional[bool] = None

  class SortOption(BaseModel):
      field: str
      order: Literal["asc", "desc"] = "desc"

  class QueryPlan(BaseModel):
      sql_filters: Optional[SqlFilters] = None
      text_search: Optional[str] = None       # Full-text search query
      semantic_query: Optional[str] = None    # Semantic similarity query
      graph_query: Optional[str] = None       # Natural language for graph search
      sort: Optional[SortOption] = None
      limit: Optional[int] = 10
      aggregation: Optional[Literal["sum", "count", "avg", "max", "min"]] = None
      group_by: Optional[Literal["category", "project", "month", "merchant"]] = None
  ```
- [ ] LLM system prompt with available categories, projects, and tag vocabulary
- [ ] Implement **Monthly LLM Budget Guard**: Check tenant's current month spend before calling model; if limit reached, fallback cleanly to standard SQL/text filter with clear UI notification
- [ ] Log token counts and cost to `LlmUsageLog` for transparency and budget tracking
- [ ] Handle ambiguous queries with clarifying questions

### 2. Search Orchestrator

- [ ] Implement query dispatcher that executes the query plan (strictly tenant-isolated)
- [ ] Combine results from multiple search layers
- [ ] Handle aggregation queries (sum, count, group by)
- [ ] Implement result merging and deduplication

### 3. Response Builder

- [ ] Format search results into natural language answers
- [ ] Include relevant details (amount, date, merchant, category)
- [ ] Support tabular output for list queries
- [ ] Support summary output for aggregation queries

### 4. Chat-Style UI

- [ ] Create `/search` page with chat-style interface
- [ ] Show AI query input at top
- [ ] Display results as cards/table below
- [ ] Support follow-up queries with context
- [ ] Show the "query plan" for transparency (expandable)

### 5. Example Queries to Support

| Query | Expected Behavior |
|-------|-------------------|
| "How much did I spend at Costco in 2025?" | SQL filter: merchant=Costco, year=2025, aggregation=sum |
| "Find my fridge receipt" | Semantic search: "fridge receipt" |
| "What are my biggest tax deductions?" | SQL: isTaxDeductible=true, sort=amount desc, limit=10 |
| "Compare office expenses Q1 vs Q2" | Two SQL queries, grouped by month |
| "Receipts similar to my last Amazon order" | Semantic search with context |

---

## Definition of Done

- [ ] Natural language queries return accurate, relevant results
- [ ] LLM correctly translates queries into structured search plans
- [ ] Aggregation queries (sum, count, average) work
- [ ] Chat-style UI allows iterative querying
- [ ] Response includes both natural language summary and structured data
- [ ] Query plan is visible for transparency
