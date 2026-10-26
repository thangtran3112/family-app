"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { createFeedbackReport } from "@/lib/desk/feedback";
import { capture, captureRoute, contextOf } from "@/lib/desk/feedbackContext";
import {
  BODY_LIMIT,
  bodyLabel,
  emptyFields,
  filledLinks,
  KIND_FILTER_LABEL,
  READY_TEXT,
  sendError,
  sendReason,
  TITLE_LIMIT,
  toCreateBody,
  type FormDraft,
  type FormFields,
} from "@/lib/desk/feedbackView";
import type { FeedbackDetail, FeedbackKind } from "@/lib/feedback/schemas";
import { CapturedContext } from "./CapturedContext";
import { HowThisWorks } from "./HowThisWorks";
import { LinksField } from "./LinksField";
import { ScreenshotsField } from "./ScreenshotsField";
import { SentPanel } from "./SentPanel";
import { SeverityRadios } from "./SeverityRadios";
import { useScreenshotUploads } from "./useScreenshotUploads";
import styles from "./feedbackForm.module.css";

const KINDS: readonly FeedbackKind[] = ["bug", "request"];

/**
 * `/feedback/new` (02s): file a bug or a feature request. The Desk fills in where she was; she writes what happened, adds links
 * and screenshots, and Send says plainly why it is off while something is missing or still uploading. Reads `?from=`, so the page
 * wraps it in Suspense.
 */
export function FeedbackForm() {
  const params = useSearchParams();
  const { setDirty } = useDeskUi();
  // Where she was: read once, when the form opens (the "Report a problem" link puts the route in `?from=`).
  const [captured] = useState(() => capture({ route: captureRoute(params.get("from"), document.referrer, window.location.origin), now: new Date() }));
  const [screen, setScreen] = useState(captured.screen);
  const [fields, setFields] = useState<FormFields>(emptyFields);
  const shots = useScreenshotUploads();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<FeedbackDetail | null>(null);
  const inFlight = useRef(false);

  const draft: FormDraft = { ...fields, uploads: shots.uploads };
  const reason = sendReason(draft);
  const touched =
    fields.title !== "" || fields.body !== "" || fields.expected !== "" || filledLinks(fields.links).length > 0 || shots.uploads.length > 0;

  // Shell navigation that stays in the page (the search box, the alerts bell) asks before it drops a half-written report.
  useEffect(() => {
    setDirty(touched && sent === null);
    return () => setDirty(false);
  }, [touched, sent, setDirty]);

  const set = (change: Partial<FormFields>) => setFields((current) => ({ ...current, ...change }));

  async function send() {
    if (reason !== null || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const body = toCreateBody(draft, {
        screen,
        route: captured.route,
        appVersion: captured.appVersion,
        capturedAt: captured.capturedAt,
        context: { ...contextOf(captured), ...(screen === captured.screen ? {} : { screen_changed_from: captured.screen }) },
      });
      setSent(await createFeedbackReport(body));
    } catch (cause) {
      setError(sendError(cause));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function cancel() {
    if (touched && !window.confirm("Discard this report?")) return;
    setDirty(false);
    window.location.assign(captured.route);
  }

  // Enter in a one-line field moves on instead of sending a half-finished report.
  const holdEnter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  const rail = (
    <RightRail
      label="About this report"
      sections={[{ id: "how", label: "How this works", node: <HowThisWorks captured={captured} screen={screen} /> }]}
    />
  );

  if (sent) {
    return (
      <div className={styles.root}>
        <div className={styles.scroll}><SentPanel report={sent} /></div>
        {rail}
      </div>
    );
  }

  const bug = fields.kind === "bug";
  return (
    <form
      className={styles.root}
      aria-label="Report a problem"
      noValidate
      onKeyDown={holdEnter}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className={styles.scroll}>
        <div role="radiogroup" aria-label="Type" className={styles.segmented}>
          {KINDS.map((kind) => (
            <button key={kind} type="button" role="radio" aria-checked={fields.kind === kind} className={styles.seg} onClick={() => set({ kind })}>
              {KIND_FILTER_LABEL[kind]}
            </button>
          ))}
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <div className={styles.labelGroup}>
              <label htmlFor="feedback-title" className={styles.label}>Title</label>
              <span className={styles.hint}>Required</span>
            </div>
            <span className={styles.counter}>{fields.title.length} / {TITLE_LIMIT}</span>
          </div>
          <input
            id="feedback-title"
            type="text"
            className={styles.input}
            maxLength={TITLE_LIMIT}
            autoComplete="off"
            autoFocus
            value={fields.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.labelGroup}>
            <label htmlFor="feedback-body" className={styles.label}>{bodyLabel(fields.kind)}</label>
            <span className={styles.hint}>{bug ? "Required · becomes \"What should it do?\" for a feature request" : "Required"}</span>
          </div>
          <textarea
            id="feedback-body"
            className={styles.textarea}
            maxLength={BODY_LIMIT}
            value={fields.body}
            onChange={(event) => set({ body: event.target.value })}
          />
        </div>

        {bug && (
          <div className={styles.field}>
            <div className={styles.labelGroup}>
              <label htmlFor="feedback-expected" className={styles.label}>What did you expect?</label>
              <span className={styles.hint}>Optional · bugs only</span>
            </div>
            <textarea
              id="feedback-expected"
              className={`${styles.textarea} ${styles.textareaShort}`}
              maxLength={BODY_LIMIT}
              value={fields.expected}
              onChange={(event) => set({ expected: event.target.value })}
            />
          </div>
        )}

        {bug && <SeverityRadios value={fields.severity} onChange={(severity) => set({ severity })} />}

        <CapturedContext captured={captured} screen={screen} onScreenChange={setScreen} />
        <LinksField links={fields.links} onChange={(links) => set({ links })} />
        <ScreenshotsField {...shots} />
      </div>

      <div className={styles.footer}>
        <button type="submit" className={styles.sendButton} disabled={reason !== null || sending}>{sending ? "Sending…" : "Send report"}</button>
        <button type="button" className={styles.cancel} onClick={cancel}>Cancel</button>
        <div className={styles.footNotes} aria-live="polite">
          <span className={error ? styles.sendError : undefined} role={error ? "alert" : undefined}>{error ?? reason ?? READY_TEXT}</span>
          <span className={styles.footMuted}>Nothing is sent anywhere else · the report stays on this Desk</span>
        </div>
      </div>
      {rail}
    </form>
  );
}
