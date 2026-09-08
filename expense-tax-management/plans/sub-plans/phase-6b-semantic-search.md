# Phase 6B — Semantic Search (pgvector)

> **Replan required (2026-09-07)**: Semantic receipt search requires tenant `ai_search` entitlement and Foundry `AI_SEARCH` quota. Basic SQL/full-text search remains available through Phase 6A. One provider-accepted user query consumes at most one product credit regardless of internal embedding/reranking calls. The fixed OpenAI route, direct Python database writes, and manual contracts in the legacy body below are historical and non-executable. See [Phase 0I sections 10-11 and 14](phase-0i-polyglot-platform-rebaseline-design.md).

> **Milestone**: 3 (Search & AI Query)
> **Dependencies**: Phase 0K, 0L, and revised Phase 6A
> **Estimated Effort**: 2-3 days

---

## Objective

Enable similarity-based search using vector embeddings, so users can find expenses by meaning rather than exact keywords.

---

## How It Works

```
User query: "supplies for my home office"
         │
         ▼
┌──────────────────┐
│ Generate Embedding│  → OpenAI text-embedding-3-small → vector(1536)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ pgvector Search  │  → SELECT * FROM expenses 
│ (cosine sim)     │     ORDER BY embedding <=> $query_embedding
└────────┬─────────┘     LIMIT 20
         │
         ▼
┌──────────────────┐
│ Re-rank Results  │  → Apply SQL filters, boost exact matches
└──────────────────┘
```

---

## Tasks

### 1. Embedding Generation

- [ ] Create embedding generation activity (for Temporal pipeline)
- [ ] Generate embeddings from combined text:
  ```
  {merchant} - {title} - {description} - {tags} - {lineItems.descriptions}
  ```
- [ ] Use OpenAI `text-embedding-3-small` (1536 dimensions, cost-effective)
- [ ] Store in `embedding` column (pgvector `vector(1536)`)
- [ ] Batch generate embeddings for existing expenses (migration script)

### 2. pgvector Setup

- [ ] Enable pgvector extension: `CREATE EXTENSION vector;`
- [ ] Create HNSW index for approximate nearest neighbor search:
  ```sql
  CREATE INDEX ON expenses 
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
  ```
- [ ] Configure index parameters for our dataset size

### 3. Search API

- [ ] Create `POST /api/v1/expenses/semantic-search` endpoint:
  ```python
  from typing import List, Optional
  from pydantic import BaseModel
  from app.schemas.expense import ExpenseResponse

  class SemanticSearchRequest(BaseModel):
      query: str
      limit: Optional[int] = 20
      filters: Optional[dict] = None

  class SemanticSearchResult(BaseModel):
      expense: ExpenseResponse
      similarity: float

  class SemanticSearchResponse(BaseModel):
      results: List[SemanticSearchResult]
  ```
- [ ] Combine semantic results with SQL filters (WHERE clause + vector ORDER BY)
- [ ] Implement hybrid scoring: `final_score = α * semantic_score + β * text_score`

### 4. UI Integration

- [ ] Add "Smart Search" toggle to search bar
- [ ] Show similarity score alongside results
- [ ] Suggest related expenses on expense detail page

---

## Definition of Done

- [ ] Embeddings are generated for all expenses during ingestion
- [ ] Semantic search returns meaningful results for natural language queries
- [ ] "supplies for home office" finds relevant expenses even without exact keyword match
- [ ] Combined semantic + structured filter search works
- [ ] Search latency < 500ms for 10K+ expenses
