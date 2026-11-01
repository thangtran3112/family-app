"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, FieldRow, Input } from "@/components/ui/Field";
import { DeskApiError } from "@/lib/api/client";
import type { SettingsChannel } from "@/lib/api/schemas";
import { channelRows, channelStatusTone, testResultText, validateChatId, type ChannelRowState } from "@/lib/desk/channelView";
import { linkTelegram, testChannel } from "@/lib/desk/settings";
import type { DeliveryPreferences } from "@/lib/settings/schema";
import styles from "./settingsDesktop.module.css";

type RowProps = {
  row: ChannelRowState;
  preferences: DeliveryPreferences;
  disabled: boolean;
  onPreference: (channel: "telegram" | "slack", enabled: boolean) => void;
  onChannelsChanged: () => void;
};

/** A 422 names the problem; anything else gets the plain line. The chat id is never echoed back. */
function linkFailureText(error: unknown): string {
  if (error instanceof DeskApiError && error.status === 422 && error.problems[0]) return error.problems[0].message;
  return "Couldn't connect Telegram · Try again";
}

export function ChannelRows({ channels, preferences, disabled, onPreference, onChannelsChanged }: Readonly<{
  channels: SettingsChannel[];
  preferences: DeliveryPreferences;
  disabled: boolean;
  onPreference: (channel: "telegram" | "slack", enabled: boolean) => void;
  onChannelsChanged: () => void;
}>) {
  return (
    <div className={styles.stack}>
      {channelRows(channels).map((row) => (
        <ChannelRow
          key={row.channel}
          row={row}
          preferences={preferences}
          disabled={disabled}
          onPreference={onPreference}
          onChannelsChanged={onChannelsChanged}
        />
      ))}
    </div>
  );
}

function ChannelRow({ row, preferences, disabled, onPreference, onChannelsChanged }: RowProps) {
  const { channel } = row;
  const [chatId, setChatId] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testText, setTestText] = useState<string | null>(null);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validateChatId(chatId);
    setLinkError(problem);
    if (problem) return;
    setLinking(true);
    try {
      await linkTelegram(chatId.trim());
      setChatId("");
      onChannelsChanged();
    } catch (error) {
      setLinkError(linkFailureText(error));
    } finally {
      setLinking(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTestText(null);
    try {
      setTestText(testResultText((await testChannel(channel)).status));
    } catch {
      setTestText(testResultText("error"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.inline}>
        <h3 className={styles.rowTitle}>{row.title}</h3>
        <Badge tone={channelStatusTone(row.status)}>{row.statusText}</Badge>
      </div>
      <p className={styles.note}>{row.note}</p>

      {channel !== "inbox" && (
        <Checkbox
          label={`Send alerts to ${row.title}`}
          // A channel that is not connected cannot deliver, so its box reads unchecked whatever was saved before.
          checked={row.status === "connected" && preferences[channel]}
          disabled={disabled || row.status !== "connected"}
          onChange={(event) => onPreference(channel, event.currentTarget.checked)}
        />
      )}

      {row.canLink && (
        <form noValidate onSubmit={(event) => void connect(event)}>
          <FieldRow>
            <Field id="telegram-chat-id" label="Telegram chat ID" error={linkError}>
              <Input inputMode="numeric" autoComplete="off" value={chatId} disabled={disabled || linking} onChange={(event) => setChatId(event.currentTarget.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={disabled || linking}>Connect</Button>
            {linking && <span role="status">Saving…</span>}
          </FieldRow>
        </form>
      )}

      {row.canTest && (
        <div className={styles.inline}>
          <Button disabled={disabled || testing} onClick={() => void runTest()}>Send test</Button>
          {(testing || testText) && <span role="status">{testing ? "Sending…" : testText}</span>}
        </div>
      )}
    </div>
  );
}
