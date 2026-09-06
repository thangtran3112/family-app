# Phase 9C — Graph Search & Query API

> **Milestone**: 4 (Graph RAG & Knowledge Graph)
> **Dependencies**: Phase 9B (Graph Ingestion)
> **Estimated Effort**: 3-4 days

---

## Objective

Expose graph-powered search capabilities that enable relational, contextual, and temporal queries impossible with traditional search.

---

## Query Types

### 1. Relational Queries
_"What did I buy at Costco?"_ → Traverse: User → Expense → PURCHASED_AT → Costco

### 2. Product Queries
_"Find my Hisense fridge receipt"_ → Search: Product node "Hisense fridge" → linked Expense

### 3. Temporal Queries
_"What were my expenses during my NYC trip in March?"_ → Filter by date + location

### 4. Pattern Queries
_"Show recurring expenses"_ → Detect: same merchant, similar amounts, periodic dates

### 5. Contextual Queries
_"Expenses related to my home office setup"_ → Graph traversal from "home office" project → all linked categories, merchants, products

---

## Tasks

### 1. Graph Search API

- [ ] Create `POST /api/v1/search/graph` endpoint:
  ```python
  from typing import List, Optional, Literal
  from pydantic import BaseModel
  from app.schemas.expense import ExpenseResponse

  class GraphSearchFilters(BaseModel):
      date_from: Optional[str] = None
      date_to: Optional[str] = None
      project_id: Optional[str] = None

  class GraphSearchRequest(BaseModel):
      query: str                                 # Natural language query
      limit: Optional[int] = 10
      filters: Optional[GraphSearchFilters] = None
      search_type: Optional[Literal["hybrid", "semantic", "keyword", "traversal"]] = "hybrid"

  class GraphContext(BaseModel):
      matched_entities: List[str]
      relationships: List[str]
      path: str                                  # Human-readable traversal path

  class GraphSearchResultItem(BaseModel):
      expense: ExpenseResponse                   # SQL record
      graph_score: float                         # Relevance from graph
      graph_context: GraphContext                # Why this was returned

  class GraphSearchResponse(BaseModel):
      results: List[GraphSearchResultItem]
      related_entities: List[dict]               # Suggested related entities
  ```

### 2. Graphiti Hybrid Search Integration

- [ ] Use Graphiti's built-in hybrid retrieval:
  - Semantic embeddings (vector similarity)
  - Keyword/BM25 (text matching)
  - Graph traversal (relationship paths)
- [ ] Configure search recipes for common query patterns
- [ ] Implement result reranking using graph distance

### 3. "Related Expenses" Feature (Direct Python Cypher Reads)

- [ ] Create `GET /api/v1/expenses/{id}/related` endpoint
- [ ] Execute direct, low-latency Cypher queries via Python `neo4j` async driver (sub-50ms):
  ```cypher
  MATCH (e:Expense {id: $expenseId, tenantId: $tenantId})
  OPTIONAL MATCH (e)-[:PURCHASED_AT]->(m:Merchant)<-[:PURCHASED_AT]-(otherM:Expense {tenantId: $tenantId})
  OPTIONAL MATCH (e)-[:CONTAINS]->(p:Product)<-[:CONTAINS]-(otherP:Expense {tenantId: $tenantId})
  RETURN otherM, otherP LIMIT 10
  ```
- [ ] Find related expenses via:
  - Same merchant → other purchases
  - Same product category → similar items
  - Same project → other project expenses
  - Same time period → temporal clustering
- [ ] Show on expense detail page as "Related Expenses" section (<50ms response)

### 4. Unified Search Orchestrator

- [ ] Create `POST /api/v1/search/unified` that combines all search layers:
  ```
  Input: natural language query
  
  1. LLM Query Planner (Phase 3C) → determines which layers to use
  2. Dispatch to:
     ├─ SQL filters (Phase 3A) → exact matches
     ├─ Full-text search (Phase 3A) → keyword matches
     ├─ Semantic search (Phase 3B) → meaning matches
     └─ Graph search (Phase 9C) → relational matches
  3. Merge & rank results
  4. Format response
  ```
- [ ] Implement weighted scoring across all search layers
- [ ] Cache frequent queries for performance

### 5. Graph Visualization (Optional)

- [ ] Create `/explore` page with interactive graph visualization
- [ ] Use `react-force-graph` or `vis-network` for rendering
- [ ] Allow clicking on nodes to expand relationships
- [ ] Filter graph by date, project, category

---

## Example Queries & Expected Results

| Natural Language Query | Graph Traversal | Expected Result |
|----------------------|-----------------|-----------------|
| "Costco fridge Hisense 2025" | User→Expense→PURCHASED_AT→Costco + CONTAINS→Hisense Fridge + date:2025 | The specific fridge receipt |
| "All home office expenses" | User→Project:HomeOffice→Expense[] | All expenses in that project |
| "What brands do I buy most?" | User→Expense[]→CONTAINS→Product→Brand, group by count | Brand frequency ranking |
| "Similar to my last Amazon order" | Expense:latest_amazon→CONTAINS→Products, find similar Products | Expenses with similar items |

---

## Definition of Done

- [ ] Graph search returns relevant results for relational queries
- [ ] "Find my Costco fridge receipt" returns the correct expense
- [ ] Related expenses show meaningful connections
- [ ] Unified search combines all 4 search layers
- [ ] Search results explain *why* they matched (graph context)
- [ ] Performance: graph queries complete within 2 seconds
