import type { Tone } from "../../components/ui/tone.ts";
import type { SettingsChannel } from "../api/schemas.ts";

// Channel rows for Settings (D11) and the Deliver step (D10): what is connected, and what she can do about it.
export type ChannelRowState = {
  channel: SettingsChannel["channel"];
  title: string;
  status: "always_on" | "connected" | "not_connected" | "not_set_up";
  statusText: string;
  /** Telegram needs her chat id before it can connect. */
  canLink: boolean;
  canTest: boolean;
  /** Plain note under the row. */
  note: string;
};

const TITLE = { inbox: "Desk inbox", telegram: "Telegram", slack: "Slack" } as const;

export function channelRow(channel: SettingsChannel): ChannelRowState {
  const title = TITLE[channel.channel];
  if (channel.channel === "inbox") {
    return { channel: "inbox", title, status: "always_on", statusText: "Always on", canLink: false, canTest: true, note: "Every alert lands in your inbox first." };
  }
  if (channel.connected) {
    return { channel: channel.channel, title, status: "connected", statusText: "Connected", canLink: channel.channel === "telegram", canTest: true, note: `Alerts can be sent to ${title}.` };
  }
  if (channel.configured) {
    return {
      channel: channel.channel,
      title,
      status: "not_connected",
      statusText: "Not connected",
      canLink: channel.channel === "telegram",
      canTest: false,
      note: channel.channel === "telegram" ? "Add your Telegram chat ID to connect." : `${title} is ready to connect.`,
    };
  }
  return { channel: channel.channel, title, status: "not_set_up", statusText: "Not set up yet", canLink: false, canTest: false, note: `${title} is not set up for this Desk yet.` };
}

export const channelRows = (channels: readonly SettingsChannel[]): ChannelRowState[] => channels.map(channelRow);

/** True when at least one non-inbox channel can deliver (D10's "no channel connected" state otherwise). */
export const hasExternalChannel = (channels: readonly SettingsChannel[]): boolean => channels.some((channel) => channel.channel !== "inbox" && channel.connected);

export const NO_CHANNEL_NOTE = "No channel connected · alerts go to your inbox only. Connect Telegram in Settings.";

/** Telegram chat ids are numbers, negative for groups. */
export function validateChatId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter your Telegram chat ID";
  return /^-?\d{3,20}$/.test(trimmed) ? null : "Chat ID is a number, for example 123456789";
}

export function testResultText(status: "sent" | "not_connected" | "failed" | "error"): string {
  switch (status) {
    case "sent": return "Test message sent";
    case "not_connected": return "Not connected yet · nothing was sent";
    default: return "Couldn't send the test · Try again";
  }
}

/** The tone of a channel's status badge: green only when it can deliver. */
export const channelStatusTone = (status: ChannelRowState["status"]): Tone => (status === "connected" ? "up" : "neutral");
