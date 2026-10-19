export const backtestSettings = [
  { label: "Strategy", value: "Pullback to the 20-day average · v3" },
  { label: "Universe", value: "Swing · 8 sample symbols" },
  { label: "Bars", value: "Daily · Jan 2, 2018–Oct 9, 2026 · synthetic fixture window" },
  { label: "Fill model", value: "Closed-bar signal · next bar open" },
  { label: "Risk", value: "0.8% equity · 1.5 × ATR stop · 2R target" },
  { label: "Costs", value: "$0.005 / share · 1 tick sample slippage each way" },
  { label: "Starting book", value: "$50,000 sample paper balance" },
];

export const backtestMetrics = [
  { label: "Total return", value: "+80.3%" }, { label: "CAGR", value: "7.0%" },
  { label: "Max drawdown", value: "−11.8%" }, { label: "Sharpe", value: "0.92" },
  { label: "Trades", value: "214" }, { label: "Win rate", value: "46.7% · 100 W / 114 L" },
  { label: "Average win / loss", value: "+1.82R / −0.94R" }, { label: "Expectancy", value: "+0.35R / trade" },
  { label: "Profit factor", value: "1.70" }, { label: "Exposure", value: "23% of days" },
  { label: "Longest losing streak", value: "7 trades" }, { label: "Average hold", value: "6.4 trading days" },
];

export const backtestYearlyReturns = [
  { label: "2018", value: 3.2 }, { label: "2019", value: 9.8 }, { label: "2020", value: 14.6 },
  { label: "2021", value: 11.2 }, { label: "2022", value: -4.9 }, { label: "2023", value: 12.4 },
  { label: "2024", value: 8.1 }, { label: "2025", value: 5.3 }, { label: "2026 YTD", value: 2.6 },
];

export const backtestEquityCurve = {
  label: "Illustrative equity index · $100 start",
  points: [
    { year: "Start", strategy: 100, benchmark: 100 }, { year: "2018", strategy: 103.2, benchmark: 103.2 },
    { year: "2019", strategy: 113.3, benchmark: 129.8 },
    { year: "2020", strategy: 129.8, benchmark: 145.0 }, { year: "2021", strategy: 144.3, benchmark: 183.0 },
    { year: "2022", strategy: 137.2, benchmark: 150.0 }, { year: "2023", strategy: 154.2, benchmark: 190.0 },
    { year: "2024", strategy: 166.7, benchmark: 220.0 }, { year: "2025", strategy: 175.5, benchmark: 235.0 },
    { year: "2026 YTD", strategy: 180.3, benchmark: 250.0 },
  ],
  strategyTotalReturn: "+80.3%",
  benchmarkTotalReturn: "+150.0%",
};

export const backtestDrawdown = [
  { year: "2018", value: 0 }, { year: "2019", value: -2.4 }, { year: "2020", value: -1.1 },
  { year: "2021", value: -3.2 }, { year: "2022", value: -11.8 }, { year: "2023", value: -4.6 },
  { year: "2024", value: -2.1 }, { year: "2025", value: -1.3 }, { year: "2026 YTD", value: -0.8 },
];

export const backtestLimitations = [
  "No look-ahead: sample signals use closed bars and information known at that time.",
  "Survivorship: this sample universe was selected today and can flatter results.",
  "Synthetic fixture values are not a run of the shipped strategy and do not predict future results.",
];

export const backtestTrades = [
  { symbol: "NVDA", entry: "Jan 12 · $128.40", exit: "Jan 22 · $139.10", result: "+1.8R" },
  { symbol: "MSFT", entry: "Feb 3 · $414.20", exit: "Feb 11 · $408.60", result: "−0.6R" },
  { symbol: "AAPL", entry: "Mar 18 · $211.70", exit: "Mar 28 · $224.90", result: "+1.4R" },
];
