"use client";

import { useRef, useState, type DragEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { screenshotUrl } from "@/lib/desk/feedback";
import { formatBytes, MAX_SCREENSHOTS, SCREENSHOT_TYPES, typeLabel, type UploadItem } from "@/lib/desk/feedbackView";
import type { ScreenshotUploads } from "./useScreenshotUploads";
import styles from "./feedbackForm.module.css";

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
    <Field id="feedback-shots" label="Screenshots" group hint={`${uploads.length} of ${MAX_SCREENSHOTS}`}>
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
        className="sr-only"
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
    </Field>
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
          <Badge tone="down">Upload failed</Badge>
        </div>
        <p className={styles.failText} role="alert">{item.failure}</p>
        <div className={styles.failActions}>
          <Button size="md" onClick={onRetry}>Retry</Button>
          <Button size="md" aria-label={`Remove ${item.filename}`} onClick={onRemove}>Remove</Button>
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
        <Button variant="ghost" size="md" iconOnly aria-label={`Cancel upload of ${item.filename}`} onClick={onRemove}><Icon name="cross" size={12} /></Button>
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
      <Button variant="ghost" size="md" iconOnly aria-label={`Remove ${item.filename}`} onClick={onRemove}><Icon name="cross" size={12} /></Button>
    </li>
  );
}
