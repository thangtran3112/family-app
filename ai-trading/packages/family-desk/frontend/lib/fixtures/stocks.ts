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
  upside: "+11.3% sample upside",
  rating: "Buy",
  confidence: "72%",
  ratingChange: { from: "Hold", to: "Buy", previousTarget: "$272", targetChange: "+$9" },
  priceTargetComparison: {
    currentPrice: 252.36,
    analystMean: 268,
    deskTarget: 281,
    low: 236,
    high: 312,
  },
};

export const stockBrief = {
  date: "Illustrative daily brief · sample close",
  counts: ["48 analyzed", "2 upgrades", "2 downgrades", "1 reached sample target"],
  verdicts: [
    { symbol: "AAPL", verdict: "Buy", change: "from Hold", target: "$281", upside: "+11.3%", confidence: "72%", earnings: "Oct 29 · after close", revision: "+2.4% EPS · 30d", summary: "Services growth offsets valuation risk." },
    { symbol: "NVDA", verdict: "Buy", change: "from Hold", target: "$392", upside: "+13.6%", confidence: "68%", earnings: "Oct 28", revision: "+1.4% EPS · 30d", summary: "Sample demand outlook positive; watch concentration." },
    { symbol: "NKE", verdict: "Sell", change: "from Hold", target: "$58", upside: "−9.4%", confidence: "59%", earnings: "Dec 18", revision: "−4.1% EPS · 30d", summary: "Sample margin trend weak; wait for a clearer turn." },
    { symbol: "KO", verdict: "Hold", change: "from Buy", target: "$71", upside: "+3.5%", confidence: "61%", earnings: "Oct 20", revision: "−0.4% EPS · 30d", summary: "A defensive sample profile; review earnings timing." },
    { symbol: "TSM", verdict: "Hold", change: "target reached", target: "$318", upside: "+1.8%", confidence: "62%", earnings: "Oct 15", revision: "+2.6% EPS · 30d", summary: "Illustrative price crossed its prior target." },
  ],
  alerts: [
    { symbol: "AAPL", time: "17:06", text: "Desk AI upgraded Hold → Buy · sample target $281" },
    { symbol: "NKE", time: "17:08", text: "Desk AI downgraded Hold → Sell · sample EPS revisions −4.1%" },
    { symbol: "JNJ", time: "08:00", text: "Sample earnings event in 3 trading days" },
  ],
};

export const stockEpsRevisions = [
  { period: "Q4 FY26", estimate: "$1.78", sevenDays: "+0.6%", thirtyDays: "+2.1%", ninetyDays: "+3.0%", actual: null },
  { period: "FY26", estimate: "$7.38", sevenDays: "—", thirtyDays: "+1.2%", ninetyDays: "—", actual: null },
  { period: "FY27", estimate: "$8.21", sevenDays: "—", thirtyDays: "+2.4%", ninetyDays: "—", actual: null },
];

export const stockAnalystDistribution = [
  { rating: "Strong buy", count: 18 }, { rating: "Buy", count: 11 }, { rating: "Hold", count: 10 },
  { rating: "Sell", count: 1 }, { rating: "Strong sell", count: 1 },
];

export const stockVoting = {
  panel: "Four-seat sample committee",
  votes: [
    { seat: "Fundamentals", vote: "Buy", reason: "Sample EPS revisions trend higher." },
    { seat: "Valuation", vote: "Hold", reason: "Sample price sits above blended value." },
    { seat: "Technicals", vote: "Buy", reason: "Illustrative trend is above long averages." },
    { seat: "Risk", vote: "Hold", reason: "Position concentration merits review." },
  ],
  result: "Buy · 2 Buy / 2 Hold · 72% confidence",
};

export const stockAlertSettings = [
  { label: "Target reached", enabled: true }, { label: "Rating changes", enabled: true },
  { label: "Earnings within 7 days", enabled: true }, { label: "EPS revisions exceed 3%", enabled: false },
];

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
  confidenceCalibration: [
    { band: "50–60%", hitRate: "53%", sampleSize: "41" },
    { band: "60–70%", hitRate: "58%", sampleSize: "77" },
    { band: "70–80%", hitRate: "64%", sampleSize: "59" },
    { band: "80%+", hitRate: "66%", sampleSize: "19" },
  ],
  targetHitRate: { reached: "38", matured: "96", rate: "40%", note: "Price reached sample base target within stated horizon." },
  settledLessons: [
    { date: "Jan 15", symbol: "MSFT", call: "Buy", return: "+9.4%", benchmark: "+5.1%", lesson: "Consensus revisions led price." },
    { date: "Feb 3", symbol: "NKE", call: "Sell", return: "−12.0%", benchmark: "+3.2%", lesson: "Sample margin deterioration persisted." },
    { date: "Mar 2", symbol: "KO", call: "Buy", return: "+1.1%", benchmark: "+4.0%", lesson: "Defensive name lagged in risk-on sample period." },
  ],
};

export const stockValuation = {
  ratios: [
    { label: "Market cap", value: "$3.74T" }, { label: "P/E (TTM)", value: "33.5" },
    { label: "Forward P/E", value: "29.8" }, { label: "Free cash flow yield", value: "2.8%" },
  ],
  methods: [
    { name: "DCF · free cash flow", target: "$247.40 weighted", note: "Bear $198 · base $246 · bull $301" },
    { name: "Owner earnings", target: "$231", note: "25% margin-of-safety buy-below $173" },
    { name: "EV / EBITDA", target: "$239", note: "Sample five-year median multiple" },
    { name: "Residual income", target: "$219", note: "Illustrative equity-value method" },
  ],
  blend: { value: "$240", dcfWeight: "60%", otherMethodsWeight: "40%", price: "$252.36", versusValue: "5.0% above" },
  scenarios: [
    { name: "Bear", value: "$198", assumption: "Slower growth; lower terminal margin" },
    { name: "Base", value: "$246", assumption: "Moderate growth; stable margins" },
    { name: "Bull", value: "$301", assumption: "Higher growth; durable services mix" },
  ],
  assumptions: [
    { label: "Sample trailing FCF", value: "$108.4B" }, { label: "Five-year FCF growth", value: "7.0%" },
    { label: "Discount rate", value: "8.6%" }, { label: "Terminal growth", value: "2.5%" },
    { label: "Diluted shares", value: "14.84B" },
  ],
  note: "Valuation figures are illustrative and are not investment advice.",
};

export const stockEarningsReaction = {
  heading: "Sample next-day reaction · last 8 reports",
  averageAbsoluteMove: "±3.6%",
  averageExcessVsBenchmark: "+0.4%",
  beats: "7 of 8 · avg +1.1% excess",
  misses: "1 · −4.2% excess",
  impliedMove: "±4.1% sample estimate",
  quarters: [
    { quarter: "Q4'24", move: 2.4, excess: 1.0 }, { quarter: "Q1'25", move: 3.1, excess: 1.2 },
    { quarter: "Q2'25", move: -4.2, excess: -4.2 }, { quarter: "Q3'25", move: 4.2, excess: 1.2 },
    { quarter: "Q4'25", move: 2.8, excess: 0.8 }, { quarter: "Q1'26", move: 3.9, excess: 1.1 },
    { quarter: "Q2'26", move: 5.3, excess: 1.0 }, { quarter: "Q3'26", move: 2.9, excess: 1.1 },
  ],
};

export const stockTimeline = [
  { type: "Earnings", date: "Thu Oct 29 · upcoming", text: "After the close; sample implied move ±4.1%" },
  { type: "Macro", date: "Wed Oct 14 · upcoming", text: "CPI release · 08:30 ET" },
  { type: "Desk AI", date: "Oct 9 · sample review", text: "Rating held; target range unchanged" },
  { type: "News", date: "Oct 6 · sample item", text: "Supplier capacity update added to watchlist" },
  { type: "Strategy", date: "Oct 2 · sample alert", text: "Long-term position crossed review threshold" },
];
