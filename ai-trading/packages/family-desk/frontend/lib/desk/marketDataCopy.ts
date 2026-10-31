import type { MarketDataCard, MarketDataClass, MarketDataOption } from "../api/schemas.ts";

// Every word the Market-data card says (02t §6), in one place, so the states are unit-tested instead of
// buried in JSX. The backend sends structure (`state`, `detail`, `in_ladder`, `configured`); this module
// turns it into the M boards' exact sentences.

export type Row = "quotes" | "options" | "bars";

const PROVIDER_LABELS: Record<string, string> = {
  ibkr: "IBKR",
  longbridge: "Longbridge",
  alpaca: "Alpaca",
  marketdata_app: "marketdata.app",
};

const QUALITY_WORDS: Record<string, string> = {
  realtime: "realtime",
  "delayed-15m": "15-min delayed",
  eod: "end of day",
  fallback: "backup",
  unavailable: "no quotes yet",
};

export const COPY = {
  title: "Market data",
  subtitle: "Pick which provider the Desk asks first. The Desk always shows who serves and how fresh it is.",
  previewBadge: "PREVIEW",
  syncing: "Routing syncing…",
  readOnlyNow: "Read-only for now",
  optionChainsNoChoice: "Alpaca (delayed) · provider choice arrives with covered-call options",
  barsServing: "closed bars only",
  ownerNote: "Only the owner changes data providers. A change saves at once and shows here.",
  readOnlyNote: "Only the owner changes data providers",
  live: "Live · realtime",
  gatewayOff: "Gateway off (outside 08:00–17:00 ET)",
  notReachable: "Gateway not reachable",
  competingSession: "Signed in elsewhere — IBKR stopped the data",
  noAccount: "No account yet",
  noKey: "No key yet",
  notOnBridge: "Not on the bridge yet",
  notInOptionsLadder: "Not in the options ladder yet",
  notABarsSource: "Not a bars source",
  barsCapability: "Daily, hourly, 1-minute",
  optionsIndicative: "Indicative · 15-min delayed",
  optionsOnly: "Options only: its stock quotes are 15 minutes delayed on every plan",
  unavailableNow: "Not available right now",
  loading: "Checking data providers…",
  loadFailed: "Data providers are unavailable right now",
  bridgeOffLine: "The bridge is not connected yet, so nothing can be switched.",
  bridgeNothing: "nothing on the bridge can serve yet",
};

export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

export const qualityWords = (quality: string | null | undefined): string =>
  quality ? (QUALITY_WORDS[quality] ?? quality) : "no quotes yet";

export function classOf(card: MarketDataCard, dataClass: MarketDataClass["data_class"]): MarketDataClass | null {
  return card.classes.find((row) => row.data_class === dataClass) ?? null;
}

/** The four providers in §6's order, even one the bridge does not know: the card always shows the same
 *  options, and a missing one reads as unavailable rather than silently disappearing. */
const ORDER = ["ibkr", "longbridge", "alpaca", "marketdata_app"] as const;
type Provider = (typeof ORDER)[number];

function optionFor(source: MarketDataClass | null, provider: Provider): MarketDataOption {
  const found = source?.options.find((option) => option.provider === provider);
  return found ?? { provider, configured: false, state: "unspecified", quality: null, in_ladder: false, detail: null };
}

/** One provider tile's words and whether it can be picked (02t §6: a disabled option carries its reason
 *  as text, never color alone). */
export function optionView(
  row: Row,
  option: MarketDataOption,
  serving: string,
): { provider: string; label: string; text: string; disabled: boolean } {
  const label = providerLabel(option.provider);
  const keep = (text: string, disabled: boolean) => ({ provider: option.provider, label, text, disabled });
  if (row === "bars") {
    // A read-only capability row (02t §6): the bars ladder has one rung until B5, so what matters is what
    // each provider can supply, not who is winning a choice nobody can make yet.
    return keep(option.provider === "alpaca" ? COPY.barsCapability : COPY.notABarsSource, true);
  }
  if (!option.in_ladder) {
    if (row === "options") {
      if (option.provider === "ibkr") return keep(COPY.notInOptionsLadder, true);
      if (option.provider === "longbridge") return keep(COPY.noAccount, true);
      if (option.provider === "marketdata_app") return keep(COPY.noKey, true);
      return keep(COPY.optionsIndicative, true);
    }
    if (option.provider === "marketdata_app") return keep(COPY.optionsOnly, true);
    if (option.provider === "longbridge") return keep(COPY.noAccount, true);
    return keep(COPY.notOnBridge, true);
  }
  if (option.detail === "competing_session") return keep(COPY.competingSession, !option.configured);
  switch (option.state) {
    case "ok":
    case "degraded":
      if (option.quality === "realtime") return keep(COPY.live, false);
      return keep(`${option.provider === serving ? "Serving now" : "Standby"} · ${qualityWords(option.quality)}`, false);
    case "off":
      return keep(COPY.gatewayOff, false);
    case "down":
      return keep(COPY.notReachable, false);
    case "not_configured":
      return keep(COPY.noKey, true);
    default:
      return keep(COPY.unavailableNow, !option.configured);
  }
}

export function optionsFor(row: Row, source: MarketDataClass | null, serving: string) {
  return ORDER.map((provider) => optionView(row, optionFor(source, provider), serving));
}

/** The header-right note on each row: the owner's choice, or what a read-only row serves. */
export function rowNote(row: Row, source: MarketDataClass | null): string {
  if (row === "options") return COPY.readOnlyNow;
  if (row === "bars") return `Read-only · ${providerLabel(source?.serving || "alpaca")}`;
  const preferred = source?.preferred ?? "";
  return preferred ? `Your choice · ${providerLabel(preferred)}` : "Bridge default";
}

/** The line under a row: who serves now, and — in shadow mode — what the bridge would serve instead. */
export function servingText(row: Row, card: MarketDataCard, source: MarketDataClass | null): string {
  if (row === "bars") return `Serving now: ${providerLabel(source?.serving || "alpaca")} · ${COPY.barsServing}`;
  if (row === "options") {
    if ((source?.ladder.length ?? 0) === 0) return COPY.optionChainsNoChoice;
    return `Serving now: ${providerLabel(source?.serving ?? "")} · ${qualityWords(source?.options.find((option) => option.provider === source?.serving)?.quality)}`;
  }
  const preferred = source?.preferred ?? "";
  const bridgeServing = source?.serving ?? "";
  const bridgeSide = preferred || bridgeServing;
  if (!bridgeSide) {
    return `Serving now: ${providerLabel(card.desk_serving)} · ${qualityWords(card.desk_quality)} · ${COPY.bridgeNothing}`;
  }
  const bridgeQuality = optionFor(source, (bridgeSide || "alpaca") as Provider).quality;
  if (card.shadow) {
    return (
      `Serving now: ${providerLabel(card.desk_serving)} · ${qualityWords(card.desk_quality)} · ` +
      `the bridge would serve ${providerLabel(bridgeSide)} · ${qualityWords(bridgeQuality)}`
    );
  }
  const because = preferred && bridgeSide && preferred !== bridgeServing ? ` · because ${reasonWords(source, preferred)}` : "";
  return `Serving now: ${providerLabel(bridgeServing)} · ${qualityWords(bridgeQuality)}${because}`;
}

/** Why the preferred provider is not the one serving (02t §5.4's vocabulary in words). */
export function reasonWords(source: MarketDataClass | null, preferred: string): string {
  const option = optionFor(source, preferred as Provider);
  const label = providerLabel(preferred);
  if (option.detail === "competing_session") return "IBKR stopped the data (signed in elsewhere)";
  if (option.state === "off") return `the ${label} gateway is off`;
  if (option.state === "down") return `the ${label} gateway isn't reachable — the laptop may be asleep`;
  if (option.state === "not_configured") return `${label} has no key yet`;
  return `${label} isn't serving right now`;
}

/** The shadow notice above the card's rows (02t §6: the card carries the badge and this sentence). */
export function previewText(card: MarketDataCard): string {
  return `The Desk still shows ${providerLabel(card.desk_serving)}. This is what the bridge would serve.`;
}

export const ownerNote = (owner: boolean): string => (owner ? COPY.ownerNote : COPY.readOnlyNote);
