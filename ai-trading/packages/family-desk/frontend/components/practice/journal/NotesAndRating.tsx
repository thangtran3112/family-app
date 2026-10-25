"use client";

import { useId, useState } from "react";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import styles from "./journal.module.css";

const MAX_NOTES = 2000;
const RATINGS = [1, 2, 3, 4, 5] as const;

export type NotesAndRatingProps = {
  notes: string | null;
  rating: number | null;
  saving: boolean;
  saved: boolean;
  onSave: (patch: { notes?: string | null; rating?: number | null }) => void;
};

/** Trimmed text, or null when nothing is left. */
const normalise = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
};

/** Self-rating (1 to 5, click the selected one to clear) and the session notes. */
export function NotesAndRating({ notes, rating, saving, saved, onSave }: NotesAndRatingProps) {
  const id = useId();
  const [draft, setDraft] = useState(notes ?? "");
  const [synced, setSynced] = useState(notes);

  // Re-sync when the saved notes change, using the "adjust state while rendering" pattern (no effect).
  // The draft follows the server only when she has not typed past the previous value, so text typed
  // while a save was in flight is kept.
  if (notes !== synced) {
    setSynced(notes);
    if (normalise(draft) === normalise(synced ?? "")) setDraft(notes ?? "");
  }

  const trimmed = normalise(draft);
  const dirty = trimmed !== normalise(notes ?? "");
  const status = saving ? PRACTICE_COPY.savingNotes : saved && !dirty ? PRACTICE_COPY.notesSaved : "";

  return (
    <div className={styles.notes}>
      <span className={styles.fieldLabel} id={`${id}-rating`}>Self-rating</span>
      <div role="radiogroup" aria-labelledby={`${id}-rating`} className={styles.ratings}>
        {RATINGS.map((value) => {
          const checked = rating === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              className={styles.rating}
              onClick={() => onSave({ rating: checked ? null : value })}
            >
              {value}
            </button>
          );
        })}
      </div>

      <label htmlFor={`${id}-notes`} className={styles.fieldLabel}>Session notes</label>
      <textarea
        id={`${id}-notes`}
        className={styles.textarea}
        value={draft}
        maxLength={MAX_NOTES}
        rows={5}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className={styles.notesFooter}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={saving || !dirty}
          onClick={() => onSave({ notes: trimmed })}
        >
          Save notes
        </button>
        <p role="status" className={styles.status}>{status}</p>
      </div>
    </div>
  );
}
