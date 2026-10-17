export const stockLongTerm = {
  symbol: "AAPL",
  company: "Apple Inc.",
  last: "$252.36",
  change: "+$1.05 (+0.42%)",
  position: "120 shares · sample average cost $148.20 · +70.3%",
  horizon: "Long-term view · illustrative 3–5 year horizon",
  bullets: [
    "Services growth and recurring revenue support a durable business profile.",
    "Valuation leaves less room for execution misses than the long-run average.",
    "Watch services growth, gross margin, and hardware replacement cycle.",
  ],
  target: "$281 sample AI target",
  analystMean: "$268 sample analyst mean",
};

export const stockBrief = {
  date: "Illustrative daily brief · sample close",
  counts: ["48 analyzed", "2 upgrades", "2 downgrades", "1 reached sample target"],
  verdicts: [
    { symbol: "AAPL", verdict: "Hold", confidence: "62%", summary: "Target unchanged; services growth offsets valuation risk." },
    { symbol: "NVDA", verdict: "Buy", confidence: "71%", summary: "Demand remains strong in this sample view; watch concentration." },
    { symbol: "NKE", verdict: "Sell", confidence: "58%", summary: "Sample margin trend is weak; wait for a clearer turn." },
  ],
};

export const stockTrackRecord = {
  description: "Sample rating changes are evaluated after 90 trading days against a broad-market benchmark, using only information marked as known at the time.",
  summary: [
    { label: "Sample calls", value: "312" }, { label: "Settled", value: "196" }, { label: "Pending", value: "116" },
  ],
  ratings: [
    { rating: "Buy", calls: "84", outperform: "61%", excessReturn: "+4.2%" },
    { rating: "Hold", calls: "76", outperform: "52%", excessReturn: "+0.8%" },
    { rating: "Sell", calls: "36", outperform: "39%", excessReturn: "−2.1%" },
  ],
};

export const stockValuation = {
  ratios: [
    { label: "Market cap", value: "$3.74T" }, { label: "P/E (TTM)", value: "33.5" },
    { label: "Forward P/E", value: "29.8" }, { label: "Free cash flow yield", value: "2.8%" },
  ],
  methods: [
    { name: "Owner earnings", target: "$244", note: "Conservative growth case" },
    { name: "Reverse DCF", target: "$263", note: "Expectations implied by sample price" },
    { name: "Analyst consensus", target: "$268", note: "Illustrative consensus estimate" },
  ],
  note: "Valuation figures are illustrative and are not investment advice.",
};

export const stockTimeline = [
  { type: "Earnings", date: "Thu Oct 29 · upcoming", text: "After the close; sample implied move ±4.1%" },
  { type: "Macro", date: "Wed Oct 14 · upcoming", text: "CPI release · 08:30 ET" },
  { type: "Desk AI", date: "Oct 9 · sample review", text: "Rating held; target range unchanged" },
  { type: "News", date: "Oct 6 · sample item", text: "Supplier capacity update added to watchlist" },
  { type: "Strategy", date: "Oct 2 · sample alert", text: "Long-term position crossed review threshold" },
];
