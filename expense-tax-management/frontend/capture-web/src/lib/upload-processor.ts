import type { CaptureOcrReviewItemV1 } from "@expense-tax/contracts";

import { fetchOcrJob, fetchOcrReviews, uploadQueuedReceipt } from "./api";
import { getQueueItem, updateQueue, type QueueItem } from "./queue";
import type { CaptureSession } from "./session";
import type { ClerkGetToken } from "./clerk";

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

// ponytail: three uncoordinated triggers (enqueue, queue page load,
// QueueAutoUploader) can all try to process the same item from a stale
// snapshot. This in-memory set is the per-tab guard against a concurrent
// double-run; it does not coordinate across tabs/devices, which is fine
// because the fresh-status re-read below also rejects an item that is no
// longer `queued`.
const inFlight = new Set<string>();

/**
 * Web session wiring design (2026-10-06) -- the shared upload step
 * `retry()`, the auto-upload-on-enqueue, and the queue-load/back-online
 * auto-processor all use. A no-op while offline (the item stays in its
 * current status for the next trigger). Otherwise marks the item
 * `uploading`, uploads, and on success marks it `processing`; on any
 * failure marks it `failed` with the error message -- never rethrows, so
 * a batch of several items keeps going past one failure.
 */
export async function processQueueItem(
  session: CaptureSession,
  item: QueueItem,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<void> {
  if (!isOnline()) return;
  if (inFlight.has(item.id)) return;
  inFlight.add(item.id);
  try {
    const fresh = await getQueueItem(item.id);
    if (!fresh || fresh.status !== "queued") return;
    await updateQueue({ ...fresh, status: "uploading", progress: 35, error: null });
    try {
      const result = await uploadQueuedReceipt(session, fresh, getToken, organizationId);
      await updateQueue({ ...fresh, ...result, status: "processing", progress: 78, error: null });
    } catch (error) {
      await updateQueue({
        ...fresh,
        status: "failed",
        error: error instanceof Error ? error.message : "Upload failed",
      });
    }
  } finally {
    inFlight.delete(item.id);
  }
}

/**
 * Processes every `queued` item sequentially. No-op with no session.
 */
export async function processQueuedItems(
  items: readonly QueueItem[],
  session: CaptureSession | null,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<void> {
  if (!session) return;
  for (const item of items.filter((candidate) => candidate.status === "queued")) {
    await processQueueItem(session, item, getToken, organizationId);
  }
}

export async function syncQueueStatuses(
  session: CaptureSession,
  items: readonly QueueItem[],
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<CaptureOcrReviewItemV1[]> {
  const reviews = await fetchOcrReviews(session, getToken, organizationId);
  const reviewJobIds = new Set(reviews.map((review) => review.jobId));
  for (const item of items) {
    if ((item.status !== "processing" && item.status !== "needs_input") || !item.fileId || !item.jobId) continue;
    const job = await fetchOcrJob(session, item.fileId, item.jobId, getToken, organizationId);
    if (job.status === "FAILED") {
      await updateQueue({ ...item, status: "failed", error: job.errorMessage ?? "OCR failed" });
    } else if (job.status === "SUCCEEDED" && reviewJobIds.has(item.jobId)) {
      await updateQueue({ ...item, status: "needs_input", progress: 100, error: null });
    } else if (job.status === "SUCCEEDED" && job.targetAggregateId) {
      await updateQueue({ ...item, status: "saved", progress: 100, error: null });
    }
  }
  return reviews;
}
