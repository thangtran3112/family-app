"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useAuth, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { deleteReceiptFile } from "@/lib/api";
import { removeReviewReceipt } from "@/lib/ocr-review";
import {
  getQueueItem,
  listQueue,
  mergeQueueWithReviews,
  removeQueue,
  updateQueue,
  type QueueDisplayItem,
} from "@/lib/queue";
import { readSession } from "@/lib/session";
import { processQueueItem, processQueuedItems, syncQueueStatuses } from "@/lib/upload-processor";

const statusLabel = {
  queued: "Queued",
  uploading: "Uploading",
  processing: "Processing",
  needs_input: "Needs input",
  saved: "Saved",
  failed: "Failed",
} as const;

export default function QueuePage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const organizationId = organization?.id;
  const [items, setItems] = useState<QueueDisplayItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const local = await listQueue();
    const session = readSession();
    if (!session || !organizationId) {
      setItems(mergeQueueWithReviews(local, []));
      return;
    }
    try {
      const reviews = await syncQueueStatuses(session, local, getToken, organizationId);
      setItems(mergeQueueWithReviews(await listQueue(), reviews));
      setError(null);
    } catch (cause) {
      setItems(mergeQueueWithReviews(local, []));
      setError(cause instanceof Error ? cause.message : "Could not refresh queue");
    }
  }, [getToken, organizationId]);

  useEffect(() => {
    let active = true;
    void listQueue().then(async (loaded) => {
      if (!active) return;
      setItems(mergeQueueWithReviews(loaded, []));
      // Web session wiring design (2026-10-06): process any item already
      // queued when this page loads, including receipts queued before
      // this release.
      await processQueuedItems(loaded, readSession(), getToken, organizationId);
      if (active) await refresh();
    });
    const timer = window.setInterval(() => { if (active) void refresh(); }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [getToken, organizationId, refresh]);

  async function retry(item: QueueDisplayItem) {
    if (!item.localId) return;
    setBusy(item.id);
    const session = readSession();
    const local = await getQueueItem(item.localId);
    if (local) {
      if (!session) {
        await updateQueue({ ...local, status: "failed", error: "Capture session unavailable" });
      } else {
        await updateQueue({ ...local, status: "queued", error: null });
        await processQueueItem(session, local, getToken, organizationId);
      }
    }
    setBusy(null);
    await refresh();
  }

  async function remove(item: QueueDisplayItem) {
    if (!window.confirm("Remove this receipt permanently?")) return;
    setBusy(item.id);
    setError(null);
    try {
      const session = readSession();
      if (item.fileId) {
        if (!session) throw new Error("Capture session unavailable");
        await removeReviewReceipt(
          () => deleteReceiptFile(session, item.fileId!, getToken, organizationId),
          () => item.localId ? removeQueue(item.localId) : Promise.resolve(),
        );
      } else if (item.localId) {
        await removeQueue(item.localId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove receipt");
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="kicker">Offline queue</p>
          <h1>Nothing gets lost.</h1>
          <p>Items remain on this device until signed upload succeeds.</p>
        </div>
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <section className="queue-list" aria-live="polite">
        {items.length === 0 ? (
          <div className="empty">
            <h2>Queue is clear</h2>
            <p>Capture a receipt to start.</p>
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id} className="queue-item">
              <div className="file-icon">
                {item.contentType?.includes("pdf") ? "PDF" : "IMG"}
              </div>
              <div>
                <h2>{item.filename}</h2>
                <p>
                  {statusLabel[item.status]}{item.modeKey ? ` · ${item.modeKey.replace("ocr_mode_", "")}` : ""}
                </p>
                <div className="progress">
                  <i style={{ width: `${item.progress}%` }} />
                </div>
                {item.error && <span className="error">{item.error}</span>}
              </div>
              <div className="row-actions">
                {item.status === "needs_input" && item.jobId && (
                  <Link className="review-link" href={`/review/${item.jobId}`}>Review</Link>
                )}
                {item.status === "failed" && item.localId && (
                  <button
                    aria-label={`Retry ${item.filename}`}
                    disabled={busy === item.id || (typeof navigator !== "undefined" && !navigator.onLine)}
                    onClick={() => void retry(item)}
                  >
                    <RefreshCw size={18} />
                  </button>
                )}
                <button
                  aria-label={`Remove ${item.filename}`}
                  disabled={busy === item.id}
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </>
  );
}
