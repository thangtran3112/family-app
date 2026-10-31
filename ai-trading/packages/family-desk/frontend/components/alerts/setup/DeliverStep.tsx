"use client";

import Link from "next/link";
import type { Problem, SettingsChannel } from "@/lib/api/schemas";
import { channelRows, hasExternalChannel, NO_CHANNEL_NOTE } from "@/lib/desk/channelView";
import { type AlertForm } from "@/lib/desk/alertForm";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import editorStyles from "@/components/screener/editor/editor.module.css";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problemCopy";

export function DeliverStep({ form, onChange, problems, channels, channelsFailed, onRetryChannels }: {
  form: AlertForm;
  onChange: (next: AlertForm) => void;
  problems: readonly Problem[];
  /** Null while the channel list loads. */
  channels: SettingsChannel[] | null;
  channelsFailed: boolean;
  onRetryChannels: () => void;
}) {
  const rows = channels === null ? [] : channelRows(channels);
  // A channel's checkbox is live only when it is connected; the status line says why it is not.
  const statusOf = (channel: "telegram" | "slack") => {
    const row = rows.find((item) => item.channel === channel);
    return { disabled: row?.status !== "connected", text: channels === null ? "Checking channels…" : (row?.statusText ?? "Not set up yet") };
  };
  const telegram = statusOf("telegram");
  const slack = statusOf("slack");
  const message = form.message.trim();

  return (
    <section className={styles.card} aria-labelledby="alert-step-deliver">
      <h2 id="alert-step-deliver" className={styles.stepTitle}>Deliver</h2>
      <fieldset className={editorStyles.group}>
        <legend>Send to</legend>
        <label className={editorStyles.option}>
          <input type="checkbox" checked readOnly disabled />
          Desk inbox
          <span className={editorStyles.note}>Always first</span>
        </label>
        <label className={editorStyles.option}>
          <input type="checkbox" checked={form.telegram} disabled={telegram.disabled && !form.telegram} onChange={(event) => onChange({ ...form, telegram: event.target.checked })} />
          Telegram
          <span className={editorStyles.note}>{telegram.text}</span>
        </label>
        <label className={editorStyles.option}>
          <input type="checkbox" checked={form.slack} disabled={slack.disabled && !form.slack} onChange={(event) => onChange({ ...form, slack: event.target.checked })} />
          Slack
          <span className={editorStyles.note}>{slack.text}</span>
        </label>
      </fieldset>
      {channelsFailed && <ErrorBlock message="Couldn't check channels · Try again" onRetry={onRetryChannels} />}
      {channels !== null && !hasExternalChannel(channels) && (
        <p role="status" className={editorStyles.note}>
          {NO_CHANNEL_NOTE} <Link href="/settings" className={styles.link}>Open Settings</Link>
        </p>
      )}
      <label className={editorStyles.field}>
        <span>Severity</span>
        <select value={form.severity} onChange={(event) => onChange({ ...form, severity: event.target.value as AlertForm["severity"] })}>
          <option value="info">Info</option>
          <option value="opportunity">Opportunity</option>
          <option value="risk">Risk</option>
        </select>
      </label>
      <label className={editorStyles.field}>
        <span>Message <span className={editorStyles.note}>(optional)</span></span>
        <input type="text" maxLength={140} value={form.message} onChange={(event) => onChange({ ...form, message: event.target.value })} />
      </label>
      <p className={editorStyles.note}>{"Type {symbol} for the ticker, {close} for the price and {time} for the time. They fill in when the alert fires."}</p>
      {message !== "" && (
        <p className={editorStyles.note}>
          Example only, with a sample price: {message.replaceAll("{symbol}", "NVDA").replaceAll("{close}", "211.50").replaceAll("{time}", "3:45 PM")}
        </p>
      )}
      {problems.map((problem, index) => (
        <span key={index} className={editorStyles.problem}>{problemLine(problem)}</span>
      ))}
    </section>
  );
}
