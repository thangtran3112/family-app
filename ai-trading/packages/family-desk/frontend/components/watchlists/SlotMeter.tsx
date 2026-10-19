"use client";

import { useEffect, useState } from "react";
import { deskFetch } from "@/lib/api/client";
import { StatusSchema } from "@/lib/api/schemas";
import { slotsText } from "@/lib/watchlists/slots";
import styles from "./watchlists.module.css";

type Slots = ReturnType<typeof StatusSchema.parse>["streaming_slots"];

export function SlotMeter() {
  const [slots, setSlots] = useState<Slots | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    void deskFetch("/api/desk/status", StatusSchema).then((status) => {
      if (current) setSlots(status.streaming_slots);
    }).catch(() => {
      if (current) {
        setSlots(null);
        setError(true);
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  function retry() {
    setLoading(true);
    setError(false);
    setRevision((value) => value + 1);
  }

  const text = slotsText(slots);
  const percent = slots && slots.max > 0
    ? Math.max(0, Math.min(100, (slots.used / slots.max) * 100))
    : 0;

  return (
    <section className={styles.sidePanel} aria-labelledby="stream-slots-title">
      <p className={styles.eyebrow} id="stream-slots-title">Streaming slots</p>
      <p className={styles.slotValue} aria-live="polite">{loading ? "Loading…" : text}</p>
      {!loading && slots && slots.max > 0 && (
        <div
          aria-label={`${text} streaming slots used`}
          aria-valuemax={slots.max}
          aria-valuemin={0}
          aria-valuenow={Math.min(slots.used, slots.max)}
          className={styles.slotTrack}
          role="meter"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className={styles.muted}>Broker slots reported by Desk API; browser event streams are not broker subscriptions.</p>
      {error && <div className={styles.error} role="alert">Could not load streaming slot status. <button className={styles.textButton} onClick={retry} type="button">Retry</button></div>}
    </section>
  );
}
