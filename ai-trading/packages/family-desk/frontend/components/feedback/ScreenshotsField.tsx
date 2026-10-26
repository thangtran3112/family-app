"use client";

import { useRef, useState, type DragEvent } from "react";
import { screenshotUrl } from "@/lib/desk/feedback";
import { formatBytes, MAX_SCREENSHOTS, SCREENSHOT_TYPES, typeLabel, type UploadItem } from "@/lib/desk/feedbackView";
import type { ScreenshotUploads } from "./useScreenshotUploads";
import styles from "./feedbackForm.module.css";

function CrossIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 2L10 10M10 2L2 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The key that pastes: ⌘V on a Mac, Ctrl+V elsewhere. Read in the browser, where this form only ever mounts. */
const pasteKey = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘V" : "Ctrl+V");

/** The screenshots: a drop zone (drop, click or paste), then one row per file with its progress or its failure (02s §Frontend). */
export function ScreenshotsField({ uploads, notice, add, retry, remove }: ScreenshotUploads) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [paste] = useState(pasteKey);
  const full = uploads.length >= MAX_SCREENSHOTS;

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (!full) add(Array.from(event.dataTransfer.files));
  };

  return (
    <div className={styles.field} role="group" aria-labelledby="feedback-shots">
      <div className={styles.labelGroup}>
        <span id="feedback-shots" className={styles.label}>Screenshots</span>
        <span className={styles.hint}>{uploads.length} of {MAX_SCREENSHOTS}</span>
      </div>
      <button
        type="button"
        className={styles.drop}
        data-over={over}
        disabled={full}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span>{full ? "That is the most a report can hold · remove one to add another" : `Drop a screenshot here, or paste with ${paste}`}</span>
        <span className={styles.dropHint}>PNG, JPEG or WebP · up to 5 MB each · up to {MAX_SCREENSHOTS}</span>
      </button>
      <input
        ref={input}
        type="file"
        className={styles.fileInput}
        accept={SCREENSHOT_TYPES.join(",")}
        multiple
        tabIndex={-1}
        aria-label="Choose screenshots"
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {notice && <p className={styles.note} role="status">{notice}</p>}
      {uploads.length > 0 && (
        <ul className={styles.rows} aria-label="Screenshots on this report">
          {uploads.map((item) => <UploadRow key={item.key} item={item} onRetry={() => retry(item.key)} onRemove={() => remove(item.key)} />)}
        </ul>
      )}
    </div>
  );
}

function UploadRow({ item, onRetry, onRemove }: { item: UploadItem; onRetry: () => void; onRemove: () => void }) {
  if (item.status === "failed") {
    return (
      <li className={styles.upRow} data-status="failed">
        <div className={styles.failHead}>
          <span className={styles.thumb} data-pending="true" aria-hidden="true" />
          <div className={styles.upBody}>
            <span className={styles.upName}>{item.filename}</span>
            <span className={styles.upMeta}>{formatBytes(item.size)} · {typeLabel(item.contentType)}</span>
          </div>
          <span className={styles.failChip}>Upload failed</span>
        </div>
        <p className={styles.failText} role="alert">{item.failure}</p>
        <div className={styles.failActions}>
          <button type="button" className={styles.smallButton} onClick={onRetry}>Retry</button>
          <button type="button" className={styles.smallButton} aria-label={`Remove ${item.filename}`} onClick={onRemove}>Remove</button>
          <span className={styles.hint}>Retry sends the same file again · remove it and add a smaller one to fix this.</span>
        </div>
      </li>
    );
  }
  if (item.status === "uploading") {
    return (
      <li className={styles.upRow} data-status="uploading">
        <span className={styles.thumb} data-pending="true" aria-hidden="true" />
        <div className={styles.upBody}>
          <div className={styles.upTop}>
            <span className={styles.upName}>{item.filename}</span>
            <span className={styles.upMeta}>{formatBytes(item.size)} · Uploading {item.progress}%</span>
          </div>
          <div className={styles.progress} role="progressbar" aria-label={`Uploading ${item.filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
            <div className={styles.progressBar} style={{ width: `${item.progress}%` }} />
          </div>
        </div>
        <button type="button" className={styles.iconButton} aria-label={`Cancel upload of ${item.filename}`} onClick={onRemove}><CrossIcon /></button>
      </li>
    );
  }
  return (
    <li className={styles.upRow} data-status="done">
      {item.attachmentId !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- A static export has no image optimizer; the bytes come from the Desk's own API.
        <img className={styles.thumb} src={screenshotUrl(item.attachmentId)} alt="" />
      ) : (
        <span className={styles.thumb} aria-hidden="true" />
      )}
      <div className={styles.upBody}>
        <span className={styles.upName}>{item.filename}</span>
        <span className={styles.upMeta}>{formatBytes(item.size)} · {typeLabel(item.contentType)} · uploaded</span>
        {item.failure && <p className={styles.failText} role="alert">{item.failure}</p>}
      </div>
      <button type="button" className={styles.iconButton} aria-label={`Remove ${item.filename}`} onClick={onRemove}><CrossIcon /></button>
    </li>
  );
}
