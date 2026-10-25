export type StrategyStage = "draft" | "alert_only" | "paper";

export type StageOption =
  | { stage: StrategyStage; label: string; enabled: boolean; reason?: string }
  | { label: "Live"; enabled: false; reason: "Not in v1" };

export function stageOptions(implementedPhase: number): StageOption[] {
  const paperEnabled = implementedPhase >= 6;
  return [
    { stage: "draft", label: "Draft", enabled: true },
    { stage: "alert_only", label: "Alert only", enabled: true },
    {
      stage: "paper",
      label: "Paper",
      enabled: paperEnabled,
      ...(paperEnabled ? {} : { reason: "Needs broker setup" }),
    },
    { label: "Live", enabled: false, reason: "Not in v1" },
  ];
}

export function nextStage(stage: StrategyStage): StrategyStage | null {
  return stage === "draft" ? "alert_only" : stage === "alert_only" ? "paper" : null;
}
