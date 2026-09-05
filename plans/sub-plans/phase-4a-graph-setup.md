# Phase 4A — Neo4j + Graphiti Setup (Native Python)

> **Milestone**: 4 (Graph RAG & Knowledge Graph)
> **Dependencies**: Milestone 1 (MVP), Phase 2A (Temporal Python)
> **Estimated Effort**: 3-4 days

---

## Objective

Set up Neo4j Community Edition (or FalkorDB) and integrate the Graphiti framework (`graphiti-core>=0.30.1`) **natively in Python** inside the FastAPI backend and Temporal workers.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                   NATIVE PYTHON GRAPH ARCHITECTURE                     │
│                                                                        │
│  ┌───────────────────────┐         ┌────────────────────────────────┐ │
│  │ Neo4j 5.26+ /         │◄───────▶│ FastAPI Backend & Workers      │ │
│  │ FalkorDB              │ Bolt    │ (Python 3.14 / 3.13)           │ │
│  │ (Graph Database)      │ 7687    │ ├─ In-process graphiti-core    │ │
│  │                       │         │ ├─ Official neo4j Python driver│ │
│  │                       │         │ ├─ Ingest via Temporal activity│ │
│  │                       │         │ └─ Fast Cypher read queries    │ │
│  └───────────────────────┘         └────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Tasks

### 1. Neo4j Setup in Docker Compose

- [ ] Add Neo4j to `infrastructure/docker-compose.yml`:
  ```yaml
  neo4j:
    image: neo4j:5.26-community
    ports:
      - "7474:7474"  # Browser UI
      - "7687:7687"  # Bolt protocol
    environment:
      - NEO4J_AUTH=neo4j/password
      - NEO4J_PLUGINS=["apoc"]
    volumes:
      - neo4j_data:/data
  ```
- [ ] Verify Neo4j starts and is accessible at http://localhost:7474

### 2. Native Graphiti Integration (`backend/app/services/graphiti.py`)

- [ ] Add dependencies to `backend/pyproject.toml`:
  - `graphiti-core>=0.30.1`
  - `neo4j>=5.27.0`
- [ ] Create Graphiti service wrapper:
  ```python
  from graphiti_core import Graphiti
  from neo4j import AsyncGraphDatabase

  class GraphService:
      def __init__(self, neo4j_uri: str, auth: tuple):
          self.driver = AsyncGraphDatabase.driver(neo4j_uri, auth=auth)
          self.graphiti = Graphiti(neo4j_uri, auth=auth)

      async def ingest_expense_episode(self, tenant_id: str, episode_data: dict):
          # Scoped to tenant via group_id
          await self.graphiti.add_episode(
              name=episode_data["name"],
              episode_body=episode_data["body"],
              source_description="Expense Receipt",
              group_id=tenant_id
          )

      async def hybrid_search(self, tenant_id: str, query: str, limit: int = 10):
          return await self.graphiti.search(
              query=query,
              group_id=tenant_id,
              limit=limit
          )

      async def execute_cypher(self, query: str, parameters: dict = None):
          async with self.driver.session() as session:
              result = await session.run(query, parameters or {})
              return [record.data() async for record in result]
  ```

### 3. FastAPI Graph Query Endpoints (`backend/app/api/v1/graph.py`)

- [ ] `POST /api/v1/search/graph`: Hybrid graph search
- [ ] `GET /api/v1/graph/entities/{id}`: Entity and relationship traversal
- [ ] `GET /api/v1/graph/health`: Graph connectivity health check

---

## Definition of Done

- [ ] Neo4j starts cleanly in Docker Compose
- [ ] `graphiti-core` initializes in-process in Python without requiring external sidecar services
- [ ] Expenses can be ingested into the graph with tenant isolation (`group_id=tenant_id`)
- [ ] Direct Cypher queries execute in < 50ms via official `neo4j` Python async driver
