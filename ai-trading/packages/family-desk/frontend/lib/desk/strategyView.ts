import type { Tone } from "../../components/ui/tone.ts";

// Display wording and tone for a strategy's stage (the list, later the builder header). Components never keep their own table.

const STAGE_LABEL: Record<string, string> = { draft: "Draft", alert_only: "Alert only", paper: "Paper" };

export const stageLabel = (stage: string): string => STAGE_LABEL[stage] ?? stage.replaceAll("_", " ");

/** A draft is quiet; alert-only and paper act on a signal, so they ask for attention. An unknown stage stays neutral. */
export const stageTone = (stage: string): Tone => (stage === "alert_only" || stage === "paper" ? "warn" : "neutral");
