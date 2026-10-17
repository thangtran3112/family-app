export const coveredCallOverview = [
  { label: "Coverable now", value: "5 sample positions" },
  { label: "After earnings", value: "4 sample positions" },
  { label: "Open short calls", value: "4 sample contracts" },
  { label: "Monthly premium", value: "$1,140 sample" },
];

export const coveredCallCandidates = [
  { symbol: "AVGO", account: "Taxable", shares: "400 sh", status: "Opportunity", strike: "$390 C", expiry: "Nov 20 · 42 DTE", delta: "0.23", bidAsk: "$6.85 / $7.15", yield: "16.9% annualized", flags: "No sample flags" },
  { symbol: "COST", account: "IRA", shares: "200 sh", status: "Below threshold", strike: "$960 C", expiry: "Nov 20 · 35 DTE", delta: "0.18", bidAsk: "$4.20 / $4.45", yield: "11.2% annualized", flags: "Below 15% sample threshold" },
  { symbol: "NKE", account: "Taxable", shares: "300 sh", status: "Desk AI: Sell", strike: "—", expiry: "—", delta: "—", bidAsk: "—", yield: "—", flags: "Illustrative verdict; not a recommendation" },
  { symbol: "KO", account: "IRA", shares: "500 sh", status: "Waits: earnings", strike: "$70 C", expiry: "Nov 20 · 42 DTE", delta: "0.21", bidAsk: "$0.80 / $0.95", yield: "—", flags: "Sample earnings date before expiry" },
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
