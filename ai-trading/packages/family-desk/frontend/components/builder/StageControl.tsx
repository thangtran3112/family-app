"use client";

import { nextStage, stageOptions, type StrategyStage } from "@/lib/strategy/stage";
import styles from "./builder.module.css";

export function StageControl({
  stage,
  hasVersion,
  pending,
  error,
  onChange,
}: {
  stage: string;
  hasVersion: boolean;
  pending: boolean;
  error: string;
  onChange: (stage: StrategyStage) => void;
}) {
  const options = stageOptions(4);
  const validStage = options.some((option) => "stage" in option && option.stage === stage);
  const next = validStage ? nextStage(stage as StrategyStage) : null;

  function choose(target: StrategyStage) {
    if (!window.confirm(`Move this strategy to ${target.replaceAll("_", " ")}?`)) return;
    onChange(target);
  }

  return (
    <section className={styles.stageControl} aria-label="Strategy stage">
      <div className={styles.stageOptions}>
        {options.map((option) => {
          if (!("stage" in option)) {
            return <span className={styles.liveNotice} key="live">Live · {option.reason}</span>;
          }
          const current = option.stage === stage;
          const canMove = option.stage === next && option.enabled && hasVersion && !pending;
          return (
            <button
              aria-pressed={current}
              className={current ? styles.currentStage : styles.stageButton}
              disabled={!canMove || current}
              key={option.stage}
              onClick={() => choose(option.stage)}
              title={!hasVersion && !current ? "Save an initial version first" : option.reason}
              type="button"
            >
              <span>{option.label}</span>
              {!option.enabled && <small>{option.reason}</small>}
              {current && <small>Current</small>}
            </button>
          );
        })}
      </div>
      {!hasVersion && <p className={styles.help}>Save an initial version before changing stage.</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
