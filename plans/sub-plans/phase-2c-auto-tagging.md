# Phase 2C — Auto-Tagging & Categorization Pipeline

> **Milestone**: 2 (Ingestion Pipeline & Auto-Tagging)
> **Dependencies**: Phase 2A (Temporal Setup)
> **Estimated Effort**: 3-4 days

---

## Objective

Build an intelligent auto-tagging and categorization system that enriches expenses with searchable metadata during ingestion.

---

## Tagging Strategy

### 1. Rule-Based Tags (Fast, Deterministic)
- **Merchant tags**: Extract from merchant name (e.g., "Costco" → `costco`, `wholesale`)
- **Category tags**: Derive from assigned category (e.g., "Office Supplies" → `office`)
- **Amount-based**: Large purchase (> $500) → `large-purchase`
- **Date-based**: Weekend → `weekend`, holiday → `holiday`
- **Payment method**: `credit-card`, `cash`, `debit`

### 2. LLM-Based Tags (Richer, Contextual)
- Send OCR text to LLM with prompt:
  > "Generate 3-5 descriptive tags for this receipt. Tags should describe: the type of purchase, specific products, store type, and any notable characteristics."
- **Budget Guard**: Before making LLM call, check tenant's monthly budget. If budget exceeded (100%), gracefully skip LLM tagging and fall back to rule-based + historical pattern tags at zero extra cost.
- Examples:
  - Costco receipt with fridge → `appliance`, `home`, `kitchen`, `costco`, `hisense`
  - Gas station → `fuel`, `vehicle`, `transportation`
  - Restaurant → `dining`, `lunch`, `team-meal`

### 3. Historical Pattern Tags
- Learn from tenant/user past tagging behavior
- If tenant always tags Home Depot as "home-improvement", suggest it automatically
- Confidence increases with more examples

---

## Tasks

- [ ] Implement rule-based tagger (fast, runs on every expense, zero LLM cost)
- [ ] Implement LLM-based tagger (runs as Temporal activity with monthly budget check & `LlmUsageLog` audit)
- [ ] Create tag suggestion API: `GET /api/v1/expenses/{id}/suggested-tags` (tenant-scoped)
- [ ] Build tag management UI (create, rename, merge, delete tags per tenant)
- [ ] Implement tag autocomplete in expense edit form
- [ ] Track tag sources (manual, rule-based, ai-generated) with confidence scores
- [ ] Build historical pattern learning (frequency analysis within tenant)

---

## Auto-Categorization Enhancement

- [ ] Improve category assignment using:
  - Merchant → category mapping (user-specific learned mapping)
  - LLM categorization with user's custom prompts
  - Historical patterns: "80% of Amazon expenses go to 'Office Supplies'"
- [ ] Implement category suggestion confidence scoring
- [ ] Allow user to accept/reject category suggestions (training data)

---

## Definition of Done

- [ ] Expenses are automatically tagged with 3-8 relevant tags during ingestion
- [ ] Tags are searchable and filterable in the expense list
- [ ] User can accept, reject, or modify auto-generated tags
- [ ] Tag confidence scores are stored and visible
- [ ] Historical patterns improve tag suggestions over time
- [ ] Tag management (CRUD, merge) works in the UI
