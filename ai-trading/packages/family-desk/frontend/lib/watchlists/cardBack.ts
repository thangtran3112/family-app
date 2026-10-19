export function cardBackValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "not available";
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
