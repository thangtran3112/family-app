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

/** The confirm text for a stage move: what it starts, and that it cannot be undone (V-Strategies-02). */
export function stageConfirmCopy(target: StrategyStage): string {
  if (target === "alert_only") {
    return "Move this strategy to alert only?\n\nAlerts start going to the channels you chose. It cannot move back to draft.";
  }
  if (target === "paper") return "Move this strategy to paper?\n\nIt will start paper trades once a broker is connected.";
  return "Move this strategy to draft?\n\nIt stops alerting until you move it forward again.";
}
