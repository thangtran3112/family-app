# Phase 5C — Mobile API Sync & Offline Mode

> **Milestone**: 5 (Mobile App — Deferred post-PWA)
> **Dependencies**: Phase 5B (Mobile Camera Capture)
> **Estimated Effort**: 3-4 days

---

## Objective

Implement robust offline-first receipt capture and background synchronization for the mobile app, ensuring users can scan receipts without cellular connectivity.

---

## Architecture

```
Online:   Capture → Upload directly to FastAPI → Poll status → Show extracted review
Offline:  Capture → Encrypt & store in local SQLite/Isar → Queue upload task → Sync via WorkManager
```

---

## Tasks

### 1. Local Offline Database
- [ ] Set up local SQLite (`sqflite`) or `isar` database for mobile caching
- [ ] Cache user profile, active categories, projects, and recent expenses
- [ ] Create `OfflineUploadQueue` table storing pending receipts and metadata

### 2. Offline Queue & Background Sync
- [ ] When network is offline: save captured image locally and enqueue in `OfflineUploadQueue`
- [ ] Integrate `workmanager` for scheduled background sync when connectivity resumes
- [ ] Implement exponential backoff retry for network errors
- [ ] Deduplicate offline uploads using local SHA-256 file hash

### 3. UI Status Indicators
- [ ] Banner / badge showing offline state and pending upload count
- [ ] Pull-to-refresh to force immediate sync when back online
- [ ] Conflict resolution notification if an item failed processing

---

## Definition of Done

- [ ] App captures and stores receipts while in airplane mode
- [ ] Pending uploads automatically sync to FastAPI backend once connectivity is restored
- [ ] Local cache displays cached expenses and projects while offline
- [ ] Background sync completes reliably without user intervention
