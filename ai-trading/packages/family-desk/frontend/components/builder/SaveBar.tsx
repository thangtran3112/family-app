"use client";

import { saveBarCopy } from "@/lib/strategy/saveBar";
import type { StrategyStage } from "@/lib/strategy/stage";
import styles from "./builder.module.css";

export function SaveBar({
  stage,
  nextVersion,
  dirty,
  hasVersion,
  valid,
  readOnly,
  blocked,
  saving,
  onSave,
}: {
  stage: StrategyStage;
  nextVersion: number;
  dirty: boolean;
  hasVersion: boolean;
  valid: boolean;
  readOnly: boolean;
  blocked: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const enabled = valid && !readOnly && !blocked && !saving && (dirty || !hasVersion);
  const { title, note } = saveBarCopy({ dirty, hasVersion, valid, readOnly, stage, nextVersion });
  return (
    <div className={styles.saveBar}>
      <div>
        <strong>{title}</strong>
        {note && <p>{note}</p>}
      </div>
      <button className={styles.saveButton} disabled={!enabled} onClick={onSave} type="button">
        {saving ? "Saving…" : `Save as v${nextVersion}`}
      </button>
    </div>
  );
}
