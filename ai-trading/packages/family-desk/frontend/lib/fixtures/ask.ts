export const conversations = [
  { title: "AAPL covered call for November", detail: "Today 15:31 · strategy draft" },
  { title: "ES overnight levels", detail: "Today 08:12" },
  { title: "Why did ORB flag NVDA?", detail: "Yesterday · signal explanation" },
  { title: "Should I trim MSFT?", detail: "Oct 8 · portfolio review" },
];

export const askPrompt = "Find a covered call on AAPL for next month, and outline an alert strategy if a similar setup appears.";

export const askReply = [
  "Two November sample candidates fit those filters. The 250 strike has a lower illustrative annualized return and no sample flags. The 245 strike pays more, but the example calendar shows an ex-dividend date before expiry, so early assignment would need review.",
  "I can draft an alert-only strategy for review. No order is created from this conversation.",
];

export const askCandidates = [
  { strike: "$250 call", expiry: "Nov 20 · 41d", bid: "$2.05", delta: "0.19", annualized: "8.0%", flags: "No sample flags" },
  { strike: "$245 call", expiry: "Nov 20 · 41d", bid: "$3.20", delta: "0.27", annualized: "12.5%", flags: "Ex-dividend before expiry" },
];

export const strategyDraft = {
  name: "Covered-call income",
  version: "Draft · based on sample v5",
  changes: [
    { field: "Delta", before: "0.15–0.30", after: "0.18–0.25" },
    { field: "Annualized yield", before: "≥15%", after: "≥8%" },
    { field: "Symbols", before: "All holdings", after: "AAPL, MSFT" },
  ],
};
