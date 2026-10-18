"use client";

import type { StrategyStage } from "@/lib/strategy/stage";
import styles from "./builder.module.css";

export function SaveBar({
  stage,
  nextVersion,
  dirty,
  hasVersion,
  valid,
  readOnly,
  saving,
  onSave,
}: {
  stage: StrategyStage;
  nextVersion: number;
  dirty: boolean;
  hasVersion: boolean;
  valid: boolean;
  readOnly: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const enabled = valid && !readOnly && !saving && (dirty || !hasVersion);
  return (
    <div className={styles.saveBar}>
      <div>
        <strong>{dirty ? "Unsaved changes" : hasVersion ? "Version saved" : "Initial version required"}</strong>
        {stage !== "draft" && <p>Saving makes version {nextVersion} the one this strategy alerts on.</p>}
      </div>
      <button className={styles.saveButton} disabled={!enabled} onClick={onSave} type="button">
        {saving ? "Saving…" : `Save as v${nextVersion}`}
      </button>
    </div>
  );
}
