# Phase 1D — Google Cloud Storage Integration

> **Milestone**: 1 (Core Expense Management MVP)
> **Dependencies**: Phase 1B (Data Model)
> **Estimated Effort**: 2-3 days

---

## Objective

Implement durable, scalable receipt/invoice file storage using Google Cloud Storage (`google-cloud-storage` Python SDK) inside the FastAPI backend.

---

## Architecture

```
Upload Flow:
  Next.js PWA → FastAPI (/api/v1/expenses/upload) → Temp Local → GCS Bucket → Signed URL → Client

Storage Structure:
  gs://expense-receipts-{env}/
    └── {tenantId}/
        ├── {userId}/
        │   ├── originals/
        │   │   └── {expenseId}/{filename}
        │   └── thumbnails/
        │       └── {expenseId}/{filename}_thumb.webp
        └── exports/
            └── {exportId}.csv
```

---

## Tasks

### 1. Storage Service Setup (`backend/app/services/storage.py`)

- [ ] Install `google-cloud-storage>=2.19.0` and `pillow>=11.0.0`
- [ ] Define Python abstract storage interface:
  ```python
  from abc import ABC, abstractmethod
  from typing import Optional, Dict

  class StorageAdapter(ABC):
      @abstractmethod
      async def upload(self, file_bytes: bytes, key: str, content_type: str, metadata: Optional[Dict] = None) -> str:
          pass

      @abstractmethod
      async def download(self, key: str) -> bytes:
          pass

      @abstractmethod
      def get_signed_url(self, key: str, expires_in_seconds: int = 3600) -> str:
          pass

      @abstractmethod
      async def delete(self, key: str) -> None:
          pass
  ```
- [ ] Implement `GCSStorageAdapter` using official Google Cloud Python client
- [ ] Implement `LocalStorageAdapter` for offline local development
- [ ] Factory function selecting adapter based on environment variable `STORAGE_BACKEND` (`gcs` | `local`)

### 2. GCS Bucket Configuration

- [ ] Create GCS bucket with:
  - Standard storage class (frequently accessed receipts)
  - Uniform bucket-level access
  - Lifecycle rules (move to Nearline after 1 year, Coldline after 3 years)
- [ ] Set up IAM service account with minimal `roles/storage.objectAdmin`
- [ ] Add env vars: `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`

### 3. Upload Integration & Thumbnailing

- [ ] Modify `POST /api/v1/expenses/upload`:
  1. Accept file upload to temp buffer/disk
  2. Perform OCR extraction
  3. Upload original file to GCS: `{tenantId}/{userId}/originals/{expenseId}/{filename}`
  4. Generate WebP thumbnail (300x300) using Pillow and upload to GCS
  5. For PDFs, generate first-page thumbnail using `pypdfium2`
  6. Update `ExpenseFile` record with `cloud_storage_url` and `cloud_storage_key`
  7. Clean up local temp file

### 4. File Serving & Signed URLs

- [ ] Implement short-lived signed URLs (1 hour expiry) for secure viewing
- [ ] Create FastAPI endpoints in `backend/app/api/v1/files.py`:
  - `GET /api/v1/files/{id}/url` — returns temporary signed URL
  - `GET /api/v1/files/{id}/thumbnail` — returns thumbnail signed URL or redirects
- [ ] Implement CSV and ZIP export upload to GCS (`{tenantId}/exports/{exportId}.zip`)

---

## Definition of Done

- [ ] Files upload to GCS with tenant-partitioned hierarchy
- [ ] Thumbnails are automatically generated (WebP) for images and PDFs
- [ ] Client receives signed URLs that allow viewing receipts securely
- [ ] Local storage fallback works seamlessly when GCS credentials are not provided
