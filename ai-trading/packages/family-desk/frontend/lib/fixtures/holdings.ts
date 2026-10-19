export const holdingsSummary = [
  { label: "Portfolio value", value: "$412,380" },
  { label: "Today", value: "+$2,915", detail: "+0.71%" },
  { label: "Unrealized", value: "+$118,240" },
  { label: "Open short calls", value: "3" },
];

export const holdings = [
  { symbol: "AAPL", account: "Taxable, IRA", shares: "400", avgCost: "$142.10", last: "$228.40", gain: "+60.7%", weight: "22%", coverage: "2 open · none left under 50% cap" },
  { symbol: "NVDA", account: "Taxable", shares: "600", avgCost: "$41.20", last: "$189.31", gain: "+359.5%", weight: "28%", coverage: "None open · 3 more possible" },
  { symbol: "MSFT", account: "Taxable", shares: "300", avgCost: "$310.55", last: "$431.20", gain: "+38.9%", weight: "31%", coverage: "1 open · none left under 50% cap" },
  { symbol: "COST", account: "IRA", shares: "40", avgCost: "$524.80", last: "$905.00", gain: "+72.4%", weight: "9%", coverage: "Never cover · cap 0%" },
  { symbol: "JPM", account: "Taxable", shares: "120", avgCost: "$185.40", last: "$243.00", gain: "+31.1%", weight: "7%", coverage: "Too few shares for a contract" },
];

export const taxLots = [
  { shares: "300 sh", cost: "$130.03", account: "Taxable", note: "Long-term sample lot" },
  { shares: "60 sh", cost: "$183.20", account: "Taxable", note: "Short-term sample lot" },
  { shares: "40 sh", cost: "$171.00", account: "IRA", note: "Tax-advantaged account" },
];

export const holdingCalls = [
  { contract: "Nov 20 · 245 call × 2", pnl: "+$252", detail: "Sold at $3.10, sample mark $1.84 · delta 0.21 · 41 days left" },
];
