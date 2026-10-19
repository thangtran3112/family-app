export const coveredCallOverview = [
  { label: "Coverable now", value: "5 sample positions" },
  { label: "After earnings", value: "4 sample positions" },
  { label: "Open short calls", value: "4 sample contracts" },
  { label: "Monthly premium", value: "$1,140 sample" },
];

export const coveredCallCandidates = [
  { symbol: "AVGO", account: "Taxable", shares: "400 sh", rank: 1, score: "23.2", status: "Opportunity", strike: "$390 C", expiry: "Nov 20 · 42 DTE", delta: "0.23", bidAsk: "$6.85 / $7.15", yield: "16.9% annualized", flags: "No sample flags", breakeven: "$345.95", cap: "$390" },
  { symbol: "AVGO", account: "Taxable", shares: "400 sh", rank: 2, score: "20.2", status: "Review", strike: "$380 C", expiry: "Nov 13 · 35 DTE", delta: "0.27", bidAsk: "$6.40 / $6.70", yield: "18.9% annualized", flags: "Delta above sample preference", breakeven: "$346.40", cap: "$380" },
  { symbol: "AVGO", account: "Taxable", shares: "400 sh", rank: 3, score: "13.7", status: "Review", strike: "$400 C", expiry: "Nov 20 · 42 DTE", delta: "0.18", bidAsk: "$5.05 / $5.35", yield: "12.4% annualized", flags: "Spread above sample preference", breakeven: "$347.75", cap: "$400" },
  { symbol: "COST", account: "IRA", shares: "200 sh", rank: 1, score: "11.4", status: "Below threshold", strike: "$960 C", expiry: "Nov 20 · 35 DTE", delta: "0.18", bidAsk: "$4.20 / $4.45", yield: "11.2% annualized", flags: "Below 15% sample threshold", breakeven: "$—", cap: "$960" },
  { symbol: "NKE", account: "Taxable", shares: "300 sh", rank: 0, score: "—", status: "Desk AI: Sell", strike: "—", expiry: "—", delta: "—", bidAsk: "—", yield: "—", flags: "Illustrative verdict; not a recommendation", breakeven: "—", cap: "—" },
  { symbol: "KO", account: "IRA", shares: "500 sh", rank: 0, score: "—", status: "Waits: earnings", strike: "$70 C", expiry: "Nov 20 · 42 DTE", delta: "0.21", bidAsk: "$0.80 / $0.95", yield: "—", flags: "Sample earnings date before expiry", breakeven: "$—", cap: "$70" },
];

export const shortCallRisks = [
  { contract: "AVGO · Oct 16 · $370 C ×1", account: "Taxable", dte: "7", spot: "$352.80", delta: "0.14", status: "OK", note: "4.7% below strike" },
  { contract: "KO · Oct 16 · $70 C ×1", account: "IRA", dte: "7", spot: "$68.60", delta: "0.38", status: "Risk", note: "Near strike · $1.40 below at 7 DTE" },
  { contract: "JNJ · Oct 16 · $175 C ×1", account: "IRA", dte: "7", spot: "$173.00", delta: "0.34", status: "Risk", note: "Sample earnings date before expiry" },
  { contract: "MSFT · Oct 23 · $540 C ×1", account: "Taxable", dte: "14", spot: "$519.60", delta: "0.28", status: "OK", note: "Sample earnings date after expiry" },
];

export const rollCandidates = [
  { expiry: "Nov 20 · $70 C", bid: "$1.10", credit: "+$0.58 / share", flag: "Sample earnings date before expiry" },
  { expiry: "Dec 4 · $72.50 C", bid: "$0.80", credit: "+$0.28 / share", flag: "Sample earnings date before expiry" },
  { expiry: "Nov 20 · $72.50 C", bid: "$0.62", credit: "+$0.10 / share", flag: "Sample earnings date before expiry" },
];

export const monthlyPremiums = [
  { month: "Jan", value: "$820" }, { month: "Feb", value: "$760" }, { month: "Mar", value: "$1,050" },
  { month: "Apr", value: "$930" }, { month: "May", value: "$1,210" }, { month: "Jun", value: "$880" },
  { month: "Jul", value: "$1,020" }, { month: "Aug", value: "$980" }, { month: "Sep", value: "$1,130" },
];

export const coveredCallPayoff = {
  underlying: "AVGO sample position · 400 shares",
  contract: "Short 390 C · sample premium $6.85/share",
  breakeven: "$345.95/share",
  cap: "$390/share",
  scenarios: [
    { underlyingAtExpiry: "$330", coveredCallPnl: "−$15.95 / share" },
    { underlyingAtExpiry: "$345.95", coveredCallPnl: "$0.00 / share" },
    { underlyingAtExpiry: "$352.80", coveredCallPnl: "+$6.85 / share" },
    { underlyingAtExpiry: "$390 or higher", coveredCallPnl: "+$44.05 / share · capped" },
  ],
};

export const assignmentHistory = [
  { symbol: "MSFT", detail: "Sample Jun 19 assignment at $500 · 100 shares called away" },
  { symbol: "KO", detail: "Sample Mar 20 assignment at $66 · shares sold at strike" },
];

export const weeklyDigest = {
  title: "Monday digest preview · sample week",
  summary: "Three sample calls expire this week",
  calls: [
    { symbol: "AVGO", contract: "$370 C", state: "OK" },
    { symbol: "KO", contract: "$70 C", state: "At risk" },
    { symbol: "JNJ", contract: "$175 C", state: "At risk" },
  ],
};
