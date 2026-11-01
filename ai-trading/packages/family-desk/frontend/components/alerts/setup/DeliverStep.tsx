"use client";

import Link from "next/link";
import type { Problem, SettingsChannel } from "@/lib/api/schemas";
import { channelRows, hasExternalChannel, NO_CHANNEL_NOTE } from "@/lib/desk/channelView";
import { type AlertForm } from "@/lib/desk/alertForm";
import { ErrorBlock } from "@/components/ui/StateBlocks";
import { Checkbox, Field, FieldError, FieldGroup, Input, Select } from "@/components/ui/Field";
import editorStyles from "@/components/screener/editor/editor.module.css";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problems";

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
      <FieldGroup legend="Send to">
        <Checkbox label="Desk inbox" hint="Always first" checked readOnly disabled />
        <Checkbox label="Telegram" hint={telegram.text} checked={form.telegram} disabled={telegram.disabled && !form.telegram} onChange={(event) => onChange({ ...form, telegram: event.target.checked })} />
        <Checkbox label="Slack" hint={slack.text} checked={form.slack} disabled={slack.disabled && !form.slack} onChange={(event) => onChange({ ...form, slack: event.target.checked })} />
      </FieldGroup>
      {channelsFailed && <ErrorBlock message="Couldn't check channels · Try again" onRetry={onRetryChannels} />}
      {channels !== null && !hasExternalChannel(channels) && (
        <p role="status" className={editorStyles.note}>
          {NO_CHANNEL_NOTE} <Link href="/settings" className={styles.link}>Open Settings</Link>
        </p>
      )}
      <Field id="alert-severity" label="Severity">
        <Select value={form.severity} onChange={(event) => onChange({ ...form, severity: event.target.value as AlertForm["severity"] })}>
          <option value="info">Info</option>
          <option value="opportunity">Opportunity</option>
          <option value="risk">Risk</option>
        </Select>
      </Field>
      <Field id="alert-message" label="Message" optional note={"Type {symbol} for the ticker, {close} for the price and {time} for the time. They fill in when the alert fires."}>
        <Input maxLength={140} value={form.message} onChange={(event) => onChange({ ...form, message: event.target.value })} />
      </Field>
      {message !== "" && (
        <p className={editorStyles.note}>
          Example only, with a sample price: {message.replaceAll("{symbol}", "NVDA").replaceAll("{close}", "211.50").replaceAll("{time}", "3:45 PM")}
        </p>
      )}
      {problems.map((problem, index) => <FieldError key={index}>{problemLine(problem)}</FieldError>)}
    </section>
  );
}
