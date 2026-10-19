export type Quality = "realtime" | "delayed-15m" | "eod" | "fallback" | "unavailable";

export function qualityLabel(quality: Quality): string {
  return quality;
}
