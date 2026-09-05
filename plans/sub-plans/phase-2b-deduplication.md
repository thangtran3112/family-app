# Phase 2B — Deduplication & Conflict Resolution

> **Milestone**: 2 (Ingestion Pipeline & Auto-Tagging)
> **Dependencies**: Phase 2A (Temporal Setup)
> **Estimated Effort**: 2-3 days

---

## Objective

Detect and handle duplicate receipts during ingestion to prevent double-counting expenses.

---

## Deduplication Strategy (Multi-Layer)

### Layer 1 — Content Hash (Exact Match)
- Hash: `SHA-256(tenantId + normalize(amount) + normalize(date) + normalize(merchant))`
- Catches: Re-uploads of the same receipt (across any user in the same tenant/family)
- Speed: O(1) lookup via index

### Layer 2 — Perceptual Image Hash (Near-Duplicate)
- Use `phash` (perceptual hash) for images
- Catches: Same receipt photographed at different angles/lighting
- Threshold: Hamming distance < 10 = likely duplicate

### Layer 3 — Semantic Similarity (Fuzzy Match)
- Compare embedding vectors of OCR text
- Catches: Same transaction from different sources (e.g., receipt + bank statement)
- Threshold: Cosine similarity > 0.95 = likely duplicate

### Layer 4 — Cross-Channel Deduplication (Manual Scan ↔ Email)
- **Problem**: User scans a receipt at Costco → later, the same order confirmation arrives via email (or vice versa). Both ingestion paths should not create separate expenses.
- **Detection strategy**:
  - **Primary**: Content hash match (amount + date + merchant) — catches most cases
  - **Fuzzy**: Same merchant + amount within ±5% + date within ±2 days — catches receipts where email and physical receipt have slightly different totals (e.g., tip added)
  - **Attachment hash**: If the email contains a PDF attachment, compare file hash against uploaded receipt file hashes
  - **Order number**: Extract order/receipt numbers from both sources and match
- **Resolution behavior**:
  - If duplicate found → **link** the email to the existing expense (don't create new)
  - **Enrich** the existing expense with any additional data from the email (e.g., order number, shipping details, item-level breakdown)
  - Record the email as an additional source on the expense for audit trail
- **Edge cases**:
  - Email arrives first, manual scan later → same logic, bidirectional matching
  - Partial match (same merchant, different amounts) → flag for user review
  - Multiple emails for same order (confirmation + shipping + delivery) → group into single expense

---

## Tasks

### Core Deduplication
- [ ] Implement content hash computation in `checkDuplicate` activity
- [ ] Implement perceptual image hashing using `sharp` + custom phash
- [ ] Implement embedding similarity check via pgvector
- [ ] Create `DuplicateMatch` table to record matches and user decisions

### Cross-Channel Deduplication (Phase 2D dependency)
- [ ] Implement `crossChannelDeduplicate` activity:
  - Compare incoming email expense against all manual-scan expenses (and vice versa)
  - Use content hash as primary, fuzzy match as secondary
  - Extract order/receipt numbers for matching
- [ ] Track expense `source` field: `manual`, `email`, `manual+email` (merged)
- [ ] Implement expense enrichment: merge email data into existing manual-scan expense
- [ ] Handle bidirectional: manual-scan-first and email-first scenarios
- [ ] Log all cross-channel matches with confidence scores

### UI
- [ ] Build UI for duplicate resolution:
  - Show side-by-side comparison (original vs. duplicate)
  - Show source indicators (📷 manual scan, 📧 email)
  - Options: Merge, Keep Both, Discard New
- [ ] Add `DUPLICATE` status to expense and link to original
- [ ] Show merged source badge on expenses (📷+📧 = both sources)

---

## Definition of Done

- [ ] Re-uploading the same receipt is flagged as duplicate
- [ ] Similar receipts (different photo, same transaction) are detected
- [ ] Cross-channel: manual scan + email receipt for same purchase → linked, not duplicated
- [ ] Cross-channel: email arrives first, manual scan later → same behavior
- [ ] Merged expenses show both sources with enriched data
- [ ] User can resolve duplicates via the UI
- [ ] Duplicate detection runs as a Temporal activity with proper retries

---

## Notes

- Cross-channel dedup is critical for Phase 2D (Email Scanning) to avoid inflating expense totals
- The `source` field on expenses enables filtering: "Show only email-sourced expenses"
- Order number extraction varies by merchant — start with top 20 merchants (Amazon, Costco, IKEA, etc.) and expand
