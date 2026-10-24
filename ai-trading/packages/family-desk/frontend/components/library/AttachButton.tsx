"use client";

import { useState } from "react";
import { DeskApiError } from "@/lib/api/client";
import type { LibraryEntry, LibraryItem } from "@/lib/api/schemas";
import { attachPreset } from "@/lib/desk/library";
import { attachLabel, attachOutcome } from "@/lib/desk/libraryView";
import styles from "./library.module.css";

type Result = { ok: true; text: string } | { ok: false; text: string };

function failureText(cause: unknown): string {
  if (cause instanceof DeskApiError) {
    if (cause.detail) return cause.detail;
    if (cause.status === 422) return "This preset can't be attached here";
  }
  return "Couldn't attach this preset · Try again";
}

/** Writes an alert-only strategy from this preset onto the list. There is no order control here. */
export function AttachButton({ entry, listId, listName }: { entry: LibraryItem | LibraryEntry; listId: number | null; listName: string | null }) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const disabled = !entry.attachable || listId === null || listName === null || saving;

  async function attach() {
    if (listId === null || listName === null) return;
    setSaving(true);
    setResult(null);
    try {
      const created = await attachPreset(entry.id, { watchlist_id: listId, channels: ["inbox"] });
      setResult({ ok: true, text: attachOutcome(created.stage, listName) });
    } catch (cause) {
      setResult({ ok: false, text: failureText(cause) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.attach}>
      <button type="button" className={styles.attachButton} disabled={disabled} onClick={() => void attach()}>
        {saving ? "Attaching…" : attachLabel(listName)}
      </button>
      {!entry.attachable && entry.attach_blocked_reason && <p className={styles.note} role="note">{entry.attach_blocked_reason}</p>}
      {result?.ok && (
        <p className={styles.result} role="status">
          {result.text} · <a href="/alerts" className={styles.link}>Open alerts</a>
        </p>
      )}
      {result && !result.ok && <p className={`${styles.result} ${styles.resultError}`} role="alert">{result.text}</p>}
    </div>
  );
}
