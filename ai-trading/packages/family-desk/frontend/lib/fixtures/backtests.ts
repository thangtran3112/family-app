export const backtestSettings = [
  { label: "Strategy", value: "Pullback to the 20-day average · v3" },
  { label: "Universe", value: "Swing · 8 sample symbols" },
  { label: "Bars", value: "Daily · illustrative historical window" },
  { label: "Fill model", value: "Closed-bar signal · next bar open" },
  { label: "Risk", value: "0.8% equity · 1.5 × ATR stop · 2R target" },
  { label: "Costs", value: "$0.005 / share · 1 tick sample slippage each way" },
  { label: "Starting book", value: "$50,000 sample paper balance" },
];

export const backtestMetrics = [
  { label: "Total return", value: "+80.3%" }, { label: "CAGR", value: "7.1%" },
  { label: "Max drawdown", value: "−18.4%" }, { label: "Win rate", value: "54.2%" },
  { label: "Profit factor", value: "1.42" }, { label: "Trades", value: "186" },
];

export const backtestMonthly = [
  { month: "Jan", result: "+2.4%" }, { month: "Feb", result: "−1.1%" },
  { month: "Mar", result: "+3.8%" }, { month: "Apr", result: "+0.6%" },
  { month: "May", result: "−0.8%" }, { month: "Jun", result: "+4.1%" },
];

export const backtestTrades = [
  { symbol: "NVDA", entry: "Jan 12 · $128.40", exit: "Jan 22 · $139.10", result: "+1.8R" },
  { symbol: "MSFT", entry: "Feb 3 · $414.20", exit: "Feb 11 · $408.60", result: "−0.6R" },
  { symbol: "AAPL", entry: "Mar 18 · $211.70", exit: "Mar 28 · $224.90", result: "+1.4R" },
];
