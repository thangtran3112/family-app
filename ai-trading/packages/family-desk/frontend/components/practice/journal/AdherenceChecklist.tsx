"use client";

import type { ReplayJournal } from "@/lib/replay/schemas";
import styles from "./journal.module.css";

export type AdherenceChecklistProps = { adherence: ReplayJournal["adherence"] };

/** The plan's checks that apply to this session, with the score on top. Checks that do not apply are left out. */
export function AdherenceChecklist({ adherence }: AdherenceChecklistProps) {
  const checks = adherence.checks.filter((check) => check.applicable);
  const score = adherence.score_pct;

  return (
    <div className={styles.adherence}>
      <p className={styles.score}>{score == null ? "No adherence score" : `Adherence ${score}%`}</p>
      {checks.length > 0 ? (
        <ul role="list" className={styles.checks}>
          {checks.map((check) => (
            <li key={check.id} role="listitem" className={styles.check}>
              <span aria-hidden="true" className={`${styles.mark} ${check.passed ? styles.up : styles.down}`}>
                {check.passed ? "✓" : "✗"}
              </span>
              <span className={styles.srOnly}>{check.passed ? "Passed: " : "Not passed: "}</span>
              <span className={styles.checkLabel}>{check.label}</span>
              <span className={styles.checkDetail}>{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No plan rule applies to this session</p>
      )}
    </div>
  );
}
