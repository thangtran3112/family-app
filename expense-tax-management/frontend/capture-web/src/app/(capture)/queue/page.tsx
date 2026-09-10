"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect, useState } from "react";

import { uploadQueuedReceipt } from "@/lib/api";
import {
  listQueue,
  removeQueue,
  updateQueue,
  type QueueItem,
} from "@/lib/queue";
import { readSession } from "@/lib/session";

export default function QueuePage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  async function refresh() {
    setItems(await listQueue());
  }
  useEffect(() => {
    let active = true;
    void listQueue().then((loaded) => {
      if (active) setItems(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  async function retry(item: QueueItem) {
    setBusy(item.id);
    const session = readSession();
    try {
      if (!session) throw new Error("Capture session unavailable");
      await updateQueue({
        ...item,
        status: "uploading",
        progress: 35,
        error: null,
      });
      const result = await uploadQueuedReceipt(session, item, getToken, organization?.id);
      await updateQueue({
        ...item,
        ...result,
        status: "processing",
        progress: 78,
        error: null,
      });
    } catch (error) {
      await updateQueue({
        ...item,
        status: "failed",
        error: error instanceof Error ? error.message : "Upload failed",
      });
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
                {item.contentType.includes("pdf") ? "PDF" : "IMG"}
              </div>
              <div>
                <h2>{item.filename}</h2>
                <p>
                  {item.status} · {item.modeKey.replace("ocr_mode_", "")}
                </p>
                <div className="progress">
                  <i style={{ width: `${item.progress}%` }} />
                </div>
                {item.error && <span className="error">{item.error}</span>}
              </div>
              <div className="row-actions">
                <button
                  aria-label={`Retry ${item.filename}`}
                  disabled={
                    busy === item.id ||
                    (typeof navigator !== "undefined" && !navigator.onLine)
                  }
                  onClick={() => void retry(item)}
                >
                  <RefreshCw size={18} />
                </button>
                <button
                  aria-label={`Remove ${item.filename}`}
                  onClick={async () => {
                    await removeQueue(item.id);
                    await refresh();
                  }}
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
