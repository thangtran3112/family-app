export function marginText(approx: number | null, asOf: string | null): string {
  if (approx === null || asOf === null || !Number.isFinite(approx)) return "not available";
  return `≈ ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(approx)} (as of ${asOf})`;
}

export type MicroSize = {
  contracts: number | null;
  riskPerContract: number | null;
  miniRisk: number | null;
  reason: string | null;
};

export function sizeMicroFirst(
  riskUsd: number,
  entry: number,
  stop: number,
  microMultiplier: number,
  miniMultiplier: number,
): MicroSize {
  const invalid = (reason: string): MicroSize => ({ contracts: null, riskPerContract: null, miniRisk: null, reason });
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return invalid("Risk must be a positive finite amount.");
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return invalid("Entry and stop must be finite prices.");
  if (!Number.isFinite(microMultiplier) || microMultiplier <= 0 || !Number.isFinite(miniMultiplier) || miniMultiplier <= 0) {
    return invalid("Contract multipliers are unavailable.");
  }
  const points = Math.abs(entry - stop);
  if (points === 0) return invalid("Stop must differ from entry.");
  const riskPerContract = points * microMultiplier;
  const miniRisk = points * miniMultiplier;
  if (!Number.isFinite(riskPerContract) || !Number.isFinite(miniRisk)) return invalid("Sizing inputs exceed supported range.");
  const quantity = riskUsd / riskPerContract;
  if (!Number.isFinite(quantity)) return invalid("Sizing inputs exceed supported range.");
  const contracts = Math.floor(quantity);
  return {
    contracts,
    riskPerContract,
    miniRisk,
    reason: contracts === 0 ? "Risk is too small for one micro contract." : null,
  };
}
