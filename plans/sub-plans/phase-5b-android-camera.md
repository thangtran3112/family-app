# Phase 5B — Mobile Camera & Receipt Capture

> **Milestone**: 5 (Mobile App — Deferred post-PWA)
> **Dependencies**: Phase 5A (Mobile App Setup)
> **Estimated Effort**: 3-4 days

---

## Objective

Implement camera capture, auto-edge detection, perspective correction, image optimization, and direct multipart upload to the FastAPI backend.

---

## Technology Choice (Flutter Candidate)

- **Scanner Plugin**: `google_mlkit_document_scanner` or Flutter `camera` plugin with custom viewfinder overlay.
- **Fallback / Native**: Android CameraX via platform channel if native edge detection is preferred.

---

## Tasks

### 1. Camera Viewfinder & Document Scanner
- [ ] Implement camera viewfinder with receipt guideline overlay
- [ ] Integrate automatic document boundary detection (ML Kit Document Scanner)
- [ ] Support manual edge adjustment / crop handles
- [ ] Implement flashlight / torch toggle for low-light receipt capture
- [ ] Gallery picker fallback for uploading existing photos/PDFs

### 2. Image Pre-processing & Optimization
- [ ] Auto-rotate and deskew captured receipts
- [ ] Compress image before upload (target < 2MB, WebP or JPEG 85% quality)
- [ ] Support multi-page receipt scanning (batch capture before upload)

### 3. Upload Flow & Real-Time Feedback
- [ ] Upload multipart file to FastAPI: `POST /api/v1/expenses/upload`
- [ ] Display upload progress bar
- [ ] Poll expense status (`PENDING` → `REVIEW`) or listen to SSE/WebSocket notifications
- [ ] Display extracted preview immediately upon completion

---

## Definition of Done

- [ ] Camera captures receipt with clear edge detection on Android
- [ ] Multi-page receipt scanning groups pages into a single upload
- [ ] Uploaded image is delivered to FastAPI backend and saved to GCS
- [ ] Extracted expense data is rendered in mobile preview for user confirmation
