import type { StrategyStage } from "./stage.ts";

export type SaveBarInput = { dirty: boolean; hasVersion: boolean; valid: boolean; readOnly: boolean; stage: StrategyStage | string; nextVersion: number };

/** What the builder's bottom bar says. An untouched form is idle, not "saved" (V-Strategies-01); a disabled Save says why (V-Strategies-04). */
export function saveBarCopy({ dirty, hasVersion, valid, readOnly, stage, nextVersion }: SaveBarInput): { title: string; note: string | null } {
  if (readOnly) return { title: "Older version", note: "You are viewing an older version. Choose the current version to edit." };
  if (!valid) return { title: "Can't save yet", note: "Fix the highlighted fields above, then save." };
  if (!hasVersion) return { title: "Initial version required", note: null };
  if (!dirty) return { title: "No changes yet", note: "Edit the form to save a new version. Alerts run on the current version until you do." };
  return { title: "Unsaved changes", note: stage === "draft" ? null : `Saving makes version ${nextVersion} the one this strategy alerts on.` };
}
