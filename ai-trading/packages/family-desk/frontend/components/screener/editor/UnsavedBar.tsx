"use client";

import { Button } from "@/components/ui/Button";
import styles from "./editor.module.css";

export function UnsavedBar({ onSave, onDiscard, saving, canSave }: { onSave: () => void; onDiscard: () => void; saving: boolean; canSave: boolean }) {
  return (
    <div className={styles.unsaved} role="region" aria-label="Unsaved changes">
      <p>You have unsaved changes</p>
      <div className={styles.actions}>
        <Button onClick={onDiscard} disabled={saving}>Discard changes</Button>
        <Button variant="primary" onClick={onSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </div>
  );
}
