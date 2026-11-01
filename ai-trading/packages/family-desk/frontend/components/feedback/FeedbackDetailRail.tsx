"use client";

import { Badge } from "@/components/ui/Badge";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import { loadFeedbackReport, screenshotUrl } from "@/lib/desk/feedback";
import {
  agentLine,
  createdAt,
  formatBytes,
  formatEtDayTime,
  KIND_LABEL,
  linkHost,
  MAX_SCREENSHOTS,
  refOf,
  reporterInitial,
  safeHref,
  severityText,
  STATUS_LABEL,
  statusTone,
} from "@/lib/desk/feedbackView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { FeedbackDetail } from "@/lib/feedback/schemas";
import { StatusTimeline } from "./StatusTimeline";
import styles from "./feedback.module.css";

/** The right rail of `/feedback`: the report named by `?id=`, or a hint to pick one. */
export function FeedbackDetailRail({ id }: { id: number | null }) {
  if (id === null) return <p className={styles.muted}>Select a report to see its details</p>;
  return <ReportDetail key={id} id={id} />;
}

function ReportDetail({ id }: { id: number }) {
  // The agents change a report while it is open, so the rail re-reads it once a minute.
  const detail = useDeskQuery(`feedback-report:${id}`, (signal) => loadFeedbackReport(id, { signal }), { intervalMs: 60_000 });
  if (detail.data === null) {
    if (detail.error === null) return <LoadingBlock label="Loading report…" height={120} />;
    if (detail.error instanceof DeskApiError && detail.error.status === 404) return <p className={styles.muted}>There is no report {refOf(id)} on this Desk.</p>;
    return <ErrorBlock subject="report" onRetry={detail.refresh} />;
  }
  // "Updated 2 h ago" counts from when this answer arrived, so a render never reads the clock.
  return <ReportBody report={detail.data} readAt={new Date(detail.updatedAt ?? 0)} />;
}

function ReportBody({ report, readAt }: { report: FeedbackDetail; readAt: Date }) {
  const line = agentLine(report, readAt);
  return (
    <div className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.railId}>{report.ref}</span>
        <Badge tone="neutral">{KIND_LABEL[report.kind]}</Badge>
        <Badge tone={statusTone(report.status)}>{STATUS_LABEL[report.status]}</Badge>
      </div>
      <h3 className={styles.railTitle}>{report.title}</h3>
      {line && <p className={styles.agentLine} data-tone={line.tone}>{line.text}</p>}
      <dl className={styles.meta}>
        <div className={styles.metaRow}><dt>Reported by</dt><dd>{reporterInitial(report.reported_by)}</dd></div>
        <div className={styles.metaRow}><dt>Created</dt><dd>{formatEtDayTime(createdAt(report))}</dd></div>
        <div className={styles.metaRow}><dt>Route</dt><dd>{report.route}</dd></div>
        {report.kind === "bug" && <div className={styles.metaRow}><dt>Severity</dt><dd>{severityText(report.severity)}</dd></div>}
        <div className={styles.metaRow}><dt>App version</dt><dd>{report.app_version}</dd></div>
      </dl>
      <p className={styles.description}>{report.body}</p>
      {report.expected && (
        <div className={styles.group}>
          <h4 className={styles.subhead}>Expected</h4>
          <p className={styles.description}>{report.expected}</p>
        </div>
      )}
      {report.links.length > 0 && (
        <div className={styles.group}>
          <h4 className={styles.subhead}>Links</h4>
          <ul className={styles.linkList}>
            {report.links.map((link, index) => {
              const href = safeHref(link.url);
              const label = link.label || linkHost(link.url);
              return (
                <li key={`${link.url}-${index}`} className={styles.linkRow}>
                  {href ? <a className={styles.linkLabel} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span className={styles.linkLabel}>{label}</span>}
                  <span className={styles.linkHost}>{linkHost(link.url)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {report.attachments.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <h4 className={styles.subhead}>Screenshots</h4>
            <span className={styles.subcount}>{report.attachments.length} of {MAX_SCREENSHOTS}</span>
          </div>
          <div className={styles.shots}>
            {report.attachments.map((shot) => (
              <a key={shot.id} className={styles.shot} href={screenshotUrl(shot.id)} target="_blank" rel="noopener noreferrer" aria-label={`View ${shot.filename}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- A static export has no image optimizer; the bytes come from the Desk's own API. */}
                <img src={screenshotUrl(shot.id)} alt="" loading="lazy" />
                <span className={styles.shotView}>View</span>
                <span className={styles.shotCaption}>{shot.filename} · {formatBytes(shot.size_bytes)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      <div className={styles.group}>
        <h4 className={styles.subhead}>Status</h4>
        <StatusTimeline events={report.events} />
      </div>
    </div>
  );
}
