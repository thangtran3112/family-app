"use client";

import styles from "./editor.module.css";

export function UnsavedBar({ onSave, onDiscard, saving, canSave }: { onSave: () => void; onDiscard: () => void; saving: boolean; canSave: boolean }) {
  return (
    <div className={styles.unsaved} role="region" aria-label="Unsaved changes">
      <p>You have unsaved changes</p>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onDiscard} disabled={saving}>Discard changes</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>
    </div>
  );
}
