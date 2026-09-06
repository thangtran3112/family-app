# Phase 9B — Expense Graph Ingestion

> **Milestone**: 4 (Graph RAG & Knowledge Graph)
> **Dependencies**: Phase 9A (Graph Setup), Phase 3A (Temporal)
> **Estimated Effort**: 3-4 days

---

## Objective

Ingest expenses into the Graphiti temporal knowledge graph as part of the Temporal processing pipeline, creating rich entity-relationship networks.

---

## Ingestion Flow

```
Temporal Activity: ingestToGraph
         │
         ▼
┌─────────────────────────┐
│  Build Episode Data     │   Transform expense into Graphiti episode
│  ├─ Expense metadata    │   - merchant, amount, date, items
│  ├─ Line items          │   - individual products/services
│  ├─ Category & project  │   - classification context
│  └─ Tags & labels       │   - user and auto-generated tags
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Graphiti Episode       │   In-process call: graphiti.add_episode(...)
│  Ingestion              │   - Graphiti extracts entities & edges
│  ├─ Entity extraction   │   - Merchant, Product, Brand, Location
│  ├─ Edge creation       │   - PURCHASED_AT, CONTAINS, etc.
│  ├─ Temporal metadata   │   - Valid from date, provenance
│  └─ Embedding gen       │   - For hybrid search
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Update SQL Record      │   Store graphNodeId back in PostgreSQL
└─────────────────────────┘
```

---

## Tasks

### 1. Episode Data Builder

- [ ] Transform `Expense` + `ExpenseFile` → Graphiti episode format:
  ```python
  episode = {
    "name": f"Expense at {merchant} on {date}",
    "body": f"""
      Purchased at {merchant} on {date} for {amount} {currency}.
      Items: {line_items_text}.
      Category: {category_name}. Project: {project_name}.
      Tags: {tags_list}.
      Payment: {payment_method}.
    """,
    "source": "expense_upload",
    "source_description": "Receipt/invoice uploaded by user",
    "reference_time": expense.date,  # Temporal anchor
    "group_id": tenant_id,  # Tenant-scoped graph for multi-tenancy
  }
  ```
- [ ] Handle different expense types (receipt, invoice, bank statement)
- [ ] Include line item details for product-level entity extraction

### 2. Temporal Activity: `ingestToGraph`

- [ ] Implement as Temporal activity with:
  - Timeout: 30 seconds
  - Retry: 3 times with exponential backoff
  - Idempotent: Skip if `graphNodeId` already set
- [ ] Call Graphiti in-process Python API (`graphiti.add_episode`)
- [ ] Store returned entity/node IDs back in PostgreSQL
- [ ] Log ingestion results for debugging

### 3. Batch Ingestion (Backfill)

- [ ] Create script to backfill existing expenses into graph
- [ ] Process in batches of 50 with rate limiting (respect LLM API limits)
- [ ] Track progress and handle failures gracefully
- [ ] Implement as a Temporal workflow for durability

### 4. Graph Enrichment

- [ ] After ingestion, run enrichment queries:
  - Link expenses to same merchant → merchant pattern detection
  - Link similar products across expenses → product network
  - Detect recurring expenses (same merchant, similar amount, monthly pattern)
- [ ] Store enrichment results as additional graph edges

### 5. Graph Consistency

- [ ] Implement sync mechanism: SQL ↔ Graph
  - When expense is updated in SQL, update graph episode
  - When expense is deleted, invalidate graph entities
- [ ] Handle edge cases: expense re-categorized, project changed, etc.
- [ ] Implement eventual consistency with retry queue

---

## Example Graph Structure

After ingesting: _"Costco receipt: Hisense fridge $799, groceries $150, total $949, June 15 2025"_

```
(User:toby) ──OWNS──▶ (Expense:exp_001)
                              │
                  ┌───────────┼───────────────┐
                  ▼           ▼               ▼
         (Merchant:Costco) (Product:Hisense) (Category:Home)
              │           Fridge $799           │
              │               │                 │
              ▼               ▼                 ▼
         (Location:        (Brand:           (Project:Home
          Wholesale)        Hisense)          Office Setup)
                              │
                              ▼
                         (Tag:appliance,
                          electronics,
                          kitchen)
```

---

## Definition of Done

- [ ] Expenses are automatically ingested into graph during Temporal pipeline
- [ ] Entities (merchants, products, brands) are extracted and linked
- [ ] Graph structure matches the designed ontology
- [ ] Backfill script can process existing expenses
- [ ] Graph stays consistent when expenses are updated/deleted
- [ ] Graph ingestion failures don't block the main processing pipeline
