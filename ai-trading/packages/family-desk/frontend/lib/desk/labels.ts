// Short plain labels shared by several screens.
export { runOnLabel } from "../spec/labels.ts";

const TIMING: Record<string, string> = { after_close: "After close", before_open: "Before open", during: "During the day" };
export const timingLabel = (timing: string): string => TIMING[timing] ?? timing.replaceAll("_", " ");

const CATEGORY: Record<string, string> = {
  candlestick: "Candlesticks",
  breakout: "Breakouts",
  trend: "Trend",
  volume: "Volume",
  futures: "Futures",
  income: "Income",
  long_term: "Long term",
};
export const categoryLabel = (category: string): string => CATEGORY[category] ?? category;

const STATUS: Record<string, string> = { active: "Active", paused: "Paused", expired: "Expired", draft: "Draft" };
export const statusLabel = (status: string): string => STATUS[status] ?? status;

const CHANNEL: Record<string, string> = { inbox: "Inbox", telegram: "Telegram", slack: "Slack" };
export const channelLabel = (channel: string): string => CHANNEL[channel] ?? channel;

const DELIVERY: Record<string, string> = {
  delivered: "Delivered",
  held_quiet_hours: "Held for quiet hours",
  no_channel: "No channel connected",
  failed: "Could not deliver",
};
export const deliveryLabel = (status: string): string => DELIVERY[status] ?? status;

export const FREQUENCY_LABEL: Record<string, string> = {
  once: "Once",
  once_per_bar: "Once per bar close",
  every_time: "Every time",
};

const ACRONYMS = new Set(["rsi", "cci", "adx", "sma", "ema", "macd", "vwma", "vwap", "atr", "obv", "mfi", "roc"]);

/** "rsi" reads RSI, "awesome_oscillator" reads Awesome Oscillator: indicator acronyms stay capitalised. */
export const indicatorName = (key: string): string =>
  key.split("_").map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word.replace(/^\w/, (letter) => letter.toUpperCase()))).join(" ");
