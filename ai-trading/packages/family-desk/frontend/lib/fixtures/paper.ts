export const paperSummary = [
  { label: "Today", value: "+$318", detail: "4 sample fills · 3 open" },
  { label: "Last 30 days", value: "+$1,910", detail: "25 sample trades · 64% win" },
  { label: "Max drawdown", value: "−$540", detail: "sample period" },
  { label: "Orders today", value: "4 of 12", detail: "illustrative family cap" },
];

export const paperPositions = [
  { symbol: "NVDA", strategy: "ORB breakout 15m · v3", side: "Long 50", entry: "$189.31", last: "$191.73", stop: "$188.10", target: "$196.00", pnl: "+$26.50" },
  { symbol: "MCL Dec", strategy: "Overnight range break · v1", side: "Short 1", entry: "$61.64", last: "$61.02", stop: "$61.95", target: "$59.80", pnl: "+$22.00" },
  { symbol: "AAPL Nov 21 260C", strategy: "Covered-call income · v5", side: "Short 2", entry: "$3.10", last: "$2.85", stop: "—", target: "$1.55", pnl: "+$50.00" },
];

export const paperStrategies = [
  { name: "Overnight range break", trades: "9", winRate: "56%", average: "+0.61R", pnl: "+$1,180", drawdown: "−$310", status: "Sample · Paper" },
  { name: "ORB breakout 15m", trades: "12", winRate: "58%", average: "+0.42R", pnl: "+$412", drawdown: "−$260", status: "Sample · Paper" },
  { name: "Covered-call income", trades: "4", winRate: "100%", average: "—", pnl: "+$318", drawdown: "—", status: "Sample · Paper" },
];

export const paperFillJournal = [
  { time: "10:08:41", action: "BUY", order: "50 NVDA @ $189.31", strategy: "ORB breakout 15m", version: "v3", signalId: "SAMPLE-SIG-001", signal: "Closed 15-minute bar broke the opening range", note: "Sample fill · no broker connection" },
  { time: "09:58:02", action: "STOP", order: "40 SOFI @ $18.92", strategy: "Gap fade", version: "v2", signalId: "SAMPLE-SIG-002", signal: "Sample stop threshold crossed", note: "Sample stopped trade · no broker connection" },
  { time: "06:02:17", action: "SELL", order: "1 MCL Dec @ $61.64", strategy: "Overnight range break", version: "v1", signalId: "SAMPLE-SIG-003", signal: "Closed bar broke overnight low", note: "Sample fill · no broker connection" },
];
