import { Button } from "@/components/ui/Button";
import { formatEtDayTime } from "@/lib/desk/feedbackView";
import { EMPTY_VALUE } from "@/lib/desk/format";
import type { FeedbackDetail } from "@/lib/feedback/schemas";
import styles from "./feedbackForm.module.css";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What she sees after Send (02s States): the new id, a way to open it, and what was attached to it. */
export function SentPanel({ report }: { report: FeedbackDetail }) {
  const dayList = typeof report.context.day_list_id === "number" ? `Day list ${report.context.day_list_id}` : EMPTY_VALUE;
  const rows: [string, string][] = [
    ["Screen", report.screen],
    ["Route", report.route],
    ["Practice day", dayList],
    ["App version", report.app_version],
    ["Captured", formatEtDayTime(report.captured_at)],
    ["Links · screenshots", `${count(report.links.length, "link", "links")} · ${count(report.attachments.length, "screenshot", "screenshots")}`],
  ];
  return (
    <section className={styles.sent} aria-labelledby="feedback-sent">
      <div className={styles.sentHead}>
        <h2 id="feedback-sent" className={styles.sentId}>{report.ref}</h2>
        <p className={styles.sentLine} role="status">Sent · thanks, it&apos;s on the Desk&apos;s list</p>
      </div>
      <div className={styles.sentActions}>
        <Button href={`/feedback?id=${report.id}`}>View it</Button>
        <Button href="/feedback" variant="secondary">All reports</Button>
      </div>
      <div className={styles.attached}>
        <h3 className={styles.subhead}>What was attached</h3>
        <dl className={styles.railRows}>
          {rows.map(([key, value]) => (
            <div key={key} className={styles.attachedRow}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
