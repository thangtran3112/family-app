import { formatEtDayTime } from "@/lib/desk/feedbackView";
import type { Captured } from "@/lib/desk/feedbackContext";
import styles from "./feedbackForm.module.css";

const STEPS: readonly { title: string; body: string }[] = [
  { title: "File it", body: "It gets an id like F-015 and shows up on the Feedback list as Open." },
  { title: "Hermes and Claude Code pick it up", body: "When the owner asks them to. There is no automatic fixing." },
  { title: "The report shows the fix", body: "A Fixed report names the commit or pull request that closed it." },
];

/** The form's right rail (board `WP5-0`): what happens to a report, and what the Desk attached without asking. */
export function HowThisWorks({ captured, screen }: { captured: Captured; screen: string }) {
  const rows: [string, string][] = [
    ["Screen", screen],
    ["Route", captured.route],
    ["App version", captured.appVersion],
    ["Captured", formatEtDayTime(captured.capturedAt)],
  ];
  return (
    <div className={styles.how}>
      <ol className={styles.steps}>
        {STEPS.map((step, index) => (
          <li key={step.title} className={styles.stepItem}>
            <span className={styles.stepNum} aria-hidden="true">{index + 1}</span>
            <div>
              <p className={styles.stepTitle}>{step.title}</p>
              <p className={styles.stepBody}>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <hr className={styles.divider} />
      <h3 className={styles.subhead}>Attached automatically</h3>
      <dl className={styles.railRows}>
        {rows.map(([key, value]) => (
          <div key={key} className={styles.attachedRow}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
