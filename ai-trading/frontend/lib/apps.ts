import type { LucideIcon } from "lucide-react";
import { Fish, LineChart, MessagesSquare, Network } from "lucide-react";

export const hubCategories = [
  { id: "research", label: "Research" },
  { id: "funds", label: "Backtesting" },
  { id: "simulation", label: "Simulation" },
] as const;

export type CategoryId = (typeof hubCategories)[number]["id"];

export type AppIconKey = "tradingAgents" | "hedgeFund" | "vibeTrading" | "mirofish";

export const appIcons: Record<AppIconKey, LucideIcon> = {
  tradingAgents: Network,
  hedgeFund: LineChart,
  vibeTrading: MessagesSquare,
  mirofish: Fish,
};

type BaseApp = {
  slug: string;
  name: string;
  subtitle: string;
  summary: string;
  launchNote: string;
  category: CategoryId;
  tags: readonly string[];
  icon: AppIconKey;
  device: "keyboard" | "touch";
  goodFor: string;
  costNote: string;
};

export type PlannedApp = BaseApp & { kind: "planned"; status: "planned"; release: string };
export type TerminalApp = BaseApp & {
  kind: "terminal";
  status: "live";
  terminalPath: `/u/${string}/`;
  hostUrl: `https://${string}/`;
};
export type ExternalApp = BaseApp & {
  kind: "external";
  status: "live";
  url: string;
  firstVisitNote: readonly string[];
};
export type UpstreamSetupApp = BaseApp & {
  kind: "upstream-setup";
  status: "setup-required";
  sourceUrl: string;
  licenseUrl: string;
  pinnedCommit: string;
  requiredKeys: readonly string[];
};
export type HubApp = PlannedApp | TerminalApp | ExternalApp | UpstreamSetupApp;

const vibeTradingUrl = process.env.NEXT_PUBLIC_VIBE_TRADING_URL ?? "https://vibe-trading.tobytran.dev";
const mirofishUrl = process.env.NEXT_PUBLIC_MIROFISH_URL ?? "https://mirofish.tobytran.dev";

export const hubApps: readonly HubApp[] = [
  {
    slug: "tradingagents",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/tradingagents/",
    hostUrl: "https://tradingagents.tobytran.dev/",
    name: "TradingAgents",
    subtitle: "Single-stock research",
    category: "research",
    tags: ["Multi-agent debate", "Single ticker", "Written report"],
    icon: "tradingAgents",
    device: "keyboard",
    summary: "Let a team of analysts debate one ticker and give you a written second opinion.",
    launchNote: "Multi-agent analysis",
    goodFor: "A second opinion on one stock.",
    costNote: "Each analysis makes dozens of LLM calls; every call is billed to the family provider keys (no spend limit set).",
  },
  {
    slug: "ai-hedge-fund",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/ai-hedge-fund/",
    hostUrl: "https://ai-hedge-fund.tobytran.dev/",
    name: "AI Hedge Fund",
    subtitle: "Funds & backtesting",
    category: "funds",
    tags: ["Investor personas", "Backtests", "Free market data"],
    icon: "hedgeFund",
    device: "keyboard",
    summary:
      "Test investor-persona strategies against market history in a simulated fund.",
    launchNote: "Free prices + SEC filings",
    goodFor: "Testing value and growth ideas against history.",
    costNote: "Market data from free sources (Alpaca daily prices, SEC filings); the earnings-surprise model is not supported. LLM usage billed to the family provider keys.",
  },
  {
    slug: "vibe-trading",
    kind: "external",
    status: "live",
    url: vibeTradingUrl,
    name: "Vibe-Trading",
    subtitle: "Conversational research",
    category: "research",
    tags: ["Natural language", "Strategy backtests", "Skill library"],
    icon: "vibeTrading",
    device: "touch",
    summary: "Explore an idea in plain English, then research, chart, and backtest it.",
    launchNote: "Natural-language workflows",
    goodFor: "Exploring an idea or backtesting a strategy described in words.",
    costNote: "LLM usage billed to the family provider keys; market data from free sources.",
    firstVisitNote: ["Nothing to set up: your hub sign-in also signs you in to Vibe-Trading."],
  },
  {
    slug: "mirofish",
    kind: "external",
    status: "live",
    url: mirofishUrl,
    name: "MiroFish",
    subtitle: "Simulation lab",
    category: "simulation",
    tags: ["Multi-agent simulation", "Upload to report", "Experimental"],
    icon: "mirofish",
    device: "touch",
    summary:
      "Upload source material, simulate a world of agents, and read the resulting report.",
    launchNote: "Not for financial prediction",
    goodFor: "Trying the original MiroFish simulator — not stock, futures, or broker analysis.",
    costNote: "Zep Cloud free tier plus LLM usage billed to the family provider keys, both kept server-side.",
    firstVisitNote: ["Nothing to set up: your hub sign-in also signs you in to MiroFish."],
  },
];

export function findApp(slug: string): HubApp | undefined {
  return hubApps.find((app) => app.slug === slug);
}

export function filterHubApps(apps: readonly HubApp[], query: string, category: CategoryId | "all") {
  const q = query.trim().toLowerCase();
  return apps.filter((app) => {
    if (category !== "all" && app.category !== category) return false;
    const categoryLabel = hubCategories.find((entry) => entry.id === app.category)?.label ?? "";
    return [app.name, app.subtitle, app.summary, app.launchNote, app.goodFor, app.costNote, categoryLabel, ...app.tags]
      .some((field) => field.toLowerCase().includes(q));
  });
}

export function getAppLaunch(app: HubApp) {
  if (app.kind === "planned") return null;
  if (app.kind === "external") return { href: app.url, label: "Open app", newTab: true };
  return {
    href: `/apps/${app.slug}`,
    label: app.kind === "terminal" ? (app.slug === "tradingagents" ? "Open workspace" : "Open terminal") : "View setup",
    newTab: false,
  };
}
