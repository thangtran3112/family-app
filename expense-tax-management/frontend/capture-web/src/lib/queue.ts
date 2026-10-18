import { openDB, type DBSchema } from "idb";
import type { CaptureOcrReviewItemV1 } from "@expense-tax/contracts";

export type QueueStatus = "queued" | "uploading" | "processing" | "needs_input" | "saved" | "failed";

export interface QueueItem {
  id: string;
  file: Blob;
  filename: string;
  contentType: string;
  modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
  status: QueueStatus;
  progress: number;
  error: string | null;
  fileId: string | null;
  jobId: string | null;
  createdAt: string;
}

export interface QueueDisplayItem {
  id: string;
  localId: string | null;
  filename: string;
  contentType: string | null;
  modeKey: QueueItem["modeKey"] | null;
  status: QueueStatus;
  progress: number;
  error: string | null;
  fileId: string | null;
  jobId: string | null;
  createdAt: string;
}

interface CaptureDb extends DBSchema {
  queue: { key: string; value: QueueItem; indexes: { "by-created": string } };
}

function db() {
  return openDB<CaptureDb>("expense-tax-capture", 1, {
    upgrade(database) {
      const store = database.createObjectStore("queue", { keyPath: "id" });
      store.createIndex("by-created", "createdAt");
    },
  });
}

export async function enqueue(file: File, modeKey: QueueItem["modeKey"]): Promise<QueueItem> {
  const item: QueueItem = {
    id: crypto.randomUUID(),
    file,
    filename: file.name || `capture-${Date.now()}.jpg`,
    contentType: file.type,
    modeKey,
    status: "queued",
    progress: 0,
    error: null,
    fileId: null,
    jobId: null,
    createdAt: new Date().toISOString(),
  };
  await (await db()).put("queue", item);
  return item;
}

export async function listQueue(): Promise<QueueItem[]> {
  return (await (await db()).getAllFromIndex("queue", "by-created")).reverse();
}

export async function getQueueItem(id: string): Promise<QueueItem | undefined> {
  return (await db()).get("queue", id);
}

export async function updateQueue(item: QueueItem): Promise<void> {
  await (await db()).put("queue", item);
}

export async function removeQueue(id: string): Promise<void> {
  await (await db()).delete("queue", id);
}

export function mergeQueueWithReviews(
  localItems: readonly QueueItem[],
  reviews: readonly CaptureOcrReviewItemV1[],
): QueueDisplayItem[] {
  const reviewsByJob = new Map(reviews.map((review) => [review.jobId, review]));
  const rows = localItems.map((item): QueueDisplayItem => {
    const review = item.jobId ? reviewsByJob.get(item.jobId) : undefined;
    if (review) reviewsByJob.delete(review.jobId);
    return {
      id: item.id,
      localId: item.id,
      filename: item.filename,
      contentType: item.contentType,
      modeKey: item.modeKey,
      status: review ? "needs_input" : item.status,
      progress: review ? 100 : item.progress,
      error: item.error,
      fileId: review?.fileId ?? item.fileId,
      jobId: review?.jobId ?? item.jobId,
      createdAt: item.createdAt,
    };
  });
  for (const review of reviewsByJob.values()) {
    rows.push({
      id: `review:${review.jobId}`,
      localId: null,
      filename: "Receipt awaiting review",
      contentType: null,
      modeKey: null,
      status: "needs_input",
      progress: 100,
      error: null,
      fileId: review.fileId,
      jobId: review.jobId,
      createdAt: review.createdAt,
    });
  }
  return rows;
}
